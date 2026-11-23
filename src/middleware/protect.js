/**
 * Auth middleware — protects routes that require a logged-in user.
 *
 * WHAT THIS DOES:
 * 1. Reads the access token from the Authorization header
 *    (format: "Bearer <token>")
 * 2. Verifies the JWT signature and checks that it hasn't expired
 *    using the ACCESS secret (a refresh token will fail here).
 * 3. Checks Redis revocation list (instant cutoff). If the token's
 *    iat (issued-at) is <= the stored revocation timestamp, the token
 *    is rejected with a generic 401. A token issued AFTER revocation
 *    (fresh login) passes.
 * 4. Attaches req.user = { userId, tenantId, roleId, permissions }.
 * 5. Runs the rest of the request inside runWithTenant({ tenantId,
 *    userId }) so downstream code can call getTenantId().
 *
 * SAFETY RULE:
 * tenantId must never be read from req.body, req.params, or req.query
 * anywhere in this project.
 *
 * TRADE-OFF:
 * One fast Redis GET per protected request in exchange for instant revocation.
 * No database call. If Redis is down, behavior is controlled by
 * REVOCATION_FAIL_MODE (default: open = allow request with warning log).
 */

import { verifyAccessToken } from '../utils/tokens.js';
import AppError from '../utils/AppError.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { isRevoked } from '../services/revocation.service.js';
import logger from '../config/logger.js';

const UNAUTHORIZED = 'Unauthorized';

const protect = async (req, _res, next) => {
  // 1. Extract the token from the Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError(UNAUTHORIZED, 401);
  }

  const token = authHeader.split(' ')[1];

  // 2. Verify signature + expiry (access secret)
  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch {
    throw new AppError(UNAUTHORIZED, 401);
  }

  // 3. Check Redis revocation list (instant cutoff)
  //    If the token's iat <= stored revokedAt, it was issued before
  //    the revocation → reject. Fresh tokens (iat > revokedAt) pass.
  const revoked = await isRevoked(decoded);
  if (revoked) {
    throw new AppError(UNAUTHORIZED, 401);
  }

  // 4. Build req.user from token payload (no DB lookup)
  req.user = {
    userId: decoded.userId,
    tenantId: decoded.tenantId,
    roleId: decoded.roleId,
    permissions: decoded.permissions || [],
  };

  // 5. Run downstream inside async tenant context
  runWithTenant(
    { tenantId: decoded.tenantId, userId: decoded.userId },
    () => next()
  );
};

export default protect;