/**
 * JWT utility — signs and verifies access + refresh tokens.
 *
 * WHAT THIS DOES:
 * Wraps jsonwebtoken so the rest of the app never handles JWT
 * secrets or expiry strings directly. There are two token types:
 *
 * 1. ACCESS TOKEN  — short-lived (15 min default), sent on every
 *    API request in the Authorization header. Contains userId,
 *    tenantId, and roleId so the auth middleware doesn't need a
 *    database call on every request.
 *
 * 2. REFRESH TOKEN — long-lived (7 days default), used ONLY to
 *    get a new access token. Stored by the client (httpOnly cookie
 *    or secure storage) and sent to POST /api/auth/refresh.
 *
 * WHY SEPARATE SECRETS:
 * If someone steals the access secret, they can forge 15-min tokens
 * but NOT extend their own session. If they stole the refresh secret
 * instead, rotating refresh tokens would still catch the reuse.
 * Defence in depth.
 */

import jwt from 'jsonwebtoken';
import env from '../config/env.js';

/**
 * Signs a short-lived access token.
 * Payload will include: userId, tenantId, roleId
 */
export function signAccessToken(payload) {
  return jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpiresIn,
  });
}

/**
 * Signs a long-lived refresh token.
 * Payload will include: userId, tenantId, tokenVersion
 */
export function signRefreshToken(payload) {
  return jwt.sign(payload, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpiresIn,
  });
}

/**
 * Verifies an access token. Returns the decoded payload or throws.
 */
export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

/**
 * Verifies a refresh token. Returns the decoded payload or throws.
 */
export function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}
