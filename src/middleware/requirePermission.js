import { PERMISSIONS } from '../constants/permissions.js';
import AppError from '../utils/AppError.js';

/**
 * Validate that every key is a known permission.
 * Called at module load time (server start) when the middleware is configured,
 * so typos like 'projct:delete' are caught immediately, not when a user hits the route.
 */
const validateKeys = (keys) => {
  for (const key of keys) {
    if (!PERMISSIONS[key]) {
      throw new Error(`Unknown permission key: ${key}`);
    }
  }
};

/**
 * requirePermission(...keys) middleware.
 *
 * Allows the request only if req.user.permissions contains ALL of the given keys.
 * Must be used after protect.js. If req.user is missing, returns 401.
 * If a permission is missing, returns 403 with message "Forbidden".
 * Unknown permission keys throw at startup (when the middleware is configured),
 * not when a user hits the route.
 */
const requirePermission = (...keys) => {
  validateKeys(keys);
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError('Unauthorized', 401));
    }
    const missing = keys.filter((key) => !req.user.permissions.includes(key));
    if (missing.length > 0) {
      return next(new AppError('Forbidden', 403));
    }
    next();
  };
};

/**
 * requireAnyPermission(...keys) middleware.
 *
 * Allows the request if at least one of the given keys matches a permission
 * in req.user.permissions. If none match, returns 403 with message "Forbidden".
 * Must be used after protect.js. If req.user is missing, returns 401.
 * Unknown permission keys throw at startup.
 */
const requireAnyPermission = (...keys) => {
  validateKeys(keys);
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError('Unauthorized', 401));
    }
    const hasAny = keys.some((key) => req.user.permissions.includes(key));
    if (!hasAny) {
      return next(new AppError('Forbidden', 403));
    }
    next();
  };
};

// Trade-off explanation:
// Permissions are baked into the JWT access token at issuance.
// A role change in the database does NOT immediately update existing tokens.
// The new role permissions take effect only after the user's next token refresh
// (up to 15 minutes, the access token expiry). This is intentional for Phase 2;
// a revocation list can be added later if immediate role changes are needed.

export { requirePermission, requireAnyPermission };