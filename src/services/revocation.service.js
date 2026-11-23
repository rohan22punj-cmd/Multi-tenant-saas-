/**
 * Instant Access Revocation using Redis.
 *
 * WHAT THIS DOES:
 * When an admin deactivates a user, changes their role, resets their password,
 * or the user logs out, we want their CURRENT access token to stop working
 * immediately — not 15 minutes later when it expires.
 *
 * HOW IT WORKS:
 * - We store a Redis key "revoked:{tenantId}:{userId}" with value = Unix timestamp
 *   of when the revocation happened (seconds since epoch).
 * - TTL = access token lifetime (from env.jwt.accessExpiresIn, default 15m).
 *   After that the token is dead anyway, so the key can disappear.
 * - protect.js reads the token's `iat` (issued-at, added by jsonwebtoken by default)
 *   and compares it with the stored revocation time. If `iat <= revokedAt`,
 *   the token was issued BEFORE the revocation → reject. If `iat > revokedAt`,
 *   the token was issued AFTER (fresh login) → allow.
 *
 * WHY COMPARE iat:
 * A token carries its issuance time. If we only stored a boolean "revoked=true",
 * a fresh login after revocation would still be blocked. Comparing iat lets
 * newly-issued tokens pass while killing old ones.
 *
 * WHY TTL = TOKEN LIFETIME:
 * An access token cannot live longer than its `expiresIn` (15m default).
 * Once the token is naturally expired, there's no need to keep the revocation
 * key around. The TTL auto-cleans stale keys.
 *
 * FAIL-OPEN vs FAIL-CLOSED:
 * If Redis is down, we have two choices:
 *   - fail-open: allow the request, log a LOUD warning. The database still
 *     blocks deactivated users at login/refresh, and the token expires in
 *     ≤15m anyway. This prevents a Redis outage from locking EVERY user out.
 *   - fail-closed: return 401/503. Safer if you prefer "no access over stale access".
 * Configurable via REVOCATION_FAIL_MODE in .env (default: open).
 *
 * TRADE-OFF:
 * One fast Redis GET per protected request in exchange for instant revocation.
 * No database call, no extra round-trip beyond the Redis lookup.
 */

import Redis from 'ioredis';
import env from '../config/env.js';
import logger from '../config/logger.js';

let redis = null;
let failMode = 'open'; // 'open' or 'closed'

/**
 * Initialize the Redis connection and read the fail-mode config.
 * Called once at server startup from server.js.
 */
export function initRevocation() {
  failMode = (process.env.REVOCATION_FAIL_MODE || 'open').toLowerCase();
  if (!['open', 'closed'].includes(failMode)) {
    logger.warn({ failMode }, 'Invalid REVOCATION_FAIL_MODE, defaulting to open');
    failMode = 'open';
  }

  redis = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 1, // fail fast, don't retry endlessly
    retryStrategy: () => null, // disable built-in retry; we want to fail fast
    lazyConnect: true,
    enableReadyCheck: false,
  });

  redis.on('error', (err) => {
    // Only log at warn level; protect.js will handle the fail-open/closed logic
    logger.warn({ err: err.message }, 'Redis revocation connection error');
  });

  return redis.connect().catch((err) => {
    logger.warn({ err: err.message }, 'Redis revocation connect failed; will run in fail-open mode');
  });
}

/**
 * Get the Redis client (for tests).
 */
export function getRedis() {
  return redis;
}

/**
 * Compute the access token TTL in seconds from env (e.g. "15m" → 900).
 * jsonwebtoken accepts strings like "15m", "1h", "7d". We parse the same format.
 */
function parseTokenTtl(expiresIn) {
  if (typeof expiresIn === 'number') return expiresIn; // already in seconds
  const match = String(expiresIn).match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60; // fallback 15m
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 60 * 60;
    case 'd': return value * 24 * 60 * 60;
    default: return 15 * 60;
  }
}

/**
 * Build the Redis key for a revoked user.
 * Format: revoked:{tenantId}:{userId}
 */
function revocationKey(tenantId, userId) {
  return `revoked:${tenantId}:${userId}`;
}

/**
 * Revoke all access tokens for a user in a tenant.
 * Stores the current Unix timestamp with TTL = access token lifetime.
 *
 * @param {string} tenantId - MongoDB ObjectId string
 * @param {string} userId - MongoDB ObjectId string
 */
export async function revokeUser(tenantId, userId) {
  if (!redis) {
    logger.warn({ tenantId, userId }, 'revokeUser called but Redis not connected');
    return;
  }

  const key = revocationKey(tenantId, userId);
  const revokedAt = Math.floor(Date.now() / 1000);
  const ttl = parseTokenTtl(env.jwt.accessExpiresIn);

  try {
    // SET with EX (expire in seconds). Overwrites any existing key.
    await redis.set(key, String(revokedAt), 'EX', ttl);
    logger.info({ tenantId, userId, revokedAt, ttl }, 'User access tokens revoked');
  } catch (err) {
    // Don't throw — revocation is best-effort. The token will expire naturally.
    logger.error({ err: err.message, tenantId, userId }, 'Failed to revoke user in Redis');
  }
}

/**
 * Check if a token payload is revoked.
 * Returns true if the key exists AND token.iat <= stored revocation time.
 * A token issued AFTER revocation (iat > revokedAt) passes.
 *
 * @param {Object} payload - decoded JWT payload (must have iat, tenantId, userId)
 * @returns {Promise<boolean>} true = revoked, false = not revoked (or Redis error in fail-open)
 */
export async function isRevoked(payload) {
  if (!redis) {
    // Redis not connected — apply fail-mode
    return handleRedisUnavailable();
  }

  const { iat, tenantId, userId } = payload;
  if (!iat || !tenantId || !userId) {
    // Malformed payload; treat as revoked to be safe
    return true;
  }

  const key = revocationKey(tenantId, userId);

  try {
    const stored = await redis.get(key);
    if (!stored) {
      // No revocation key → not revoked
      return false;
    }
    const revokedAt = parseInt(stored, 10);
    // Token is revoked if it was issued at or before the revocation time
    return iat <= revokedAt;
  } catch (err) {
    // Redis error — apply fail-mode
    logger.error({ err: err.message, key }, 'Redis error during revocation check');
    return handleRedisUnavailable();
  }
}

/**
 * Apply the configured fail-mode when Redis is unavailable.
 * fail-open: return false (allow request), but the warning is already logged.
 * fail-closed: return true (treat as revoked → 401).
 */
function handleRedisUnavailable() {
  if (failMode === 'closed') {
    return true; // treat as revoked
  }
  // fail-open (default): allow the request
  return false;
}