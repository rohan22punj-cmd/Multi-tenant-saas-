/**
 * Auth middleware — protects routes that require a logged-in user.
 *
 * WHAT THIS DOES:
 * 1. Reads the access token from the Authorization header
 *    (format: "Bearer <token>")
 * 2. Verifies the JWT signature and checks that it hasn't expired
 *    using the ACCESS secret (a refresh token will fail here).
 * 3. Takes userId, tenantId, roleId, permissions directly from the
 *    token payload — NO database call. This is fast (no extra round-
 *    trip) but means a deactivated user keeps access for up to
 *    15 minutes until the token expires. That trade-off is intentional
 *    for Phase 2; we can add a revocation list later if needed.
 * 4. Attaches req.user = { userId, tenantId, roleId, permissions }.
 * 5. Runs the rest of the request inside runWithTenant({ tenantId,
 *    userId }) so downstream code can call getTenantId().
 *
 * SAFETY RULE:
 * tenantId must never be read from req.body, req.params, or req.query
 * anywhere in this project.
 */

import { verifyAccessToken } from '../utils/tokens.js';
import AppError from '../utils/AppError.js';
import { runWithTenant } from '../utils/tenantContext.js';

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

  // 3. Build req.user from token payload (no DB lookup)
  req.user = {
    userId: decoded.userId,
    tenantId: decoded.tenantId,
    roleId: decoded.roleId,
    permissions: decoded.permissions || [],
  };

  // 4. Run downstream inside async tenant context
  runWithTenant(
    { tenantId: decoded.tenantId, userId: decoded.userId },
    () => next()
  );
};

export default protect;