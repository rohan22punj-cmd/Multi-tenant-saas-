/**
 * Auth middleware — protects routes that require a logged-in user.
 *
 * WHAT THIS DOES:
 * 1. Reads the access token from the Authorization header
 *    (format: "Bearer <token>")
 * 2. Verifies the JWT signature and checks that it hasn't expired
 * 3. Loads the user's permissions from the Role collection
 * 4. Attaches userId, tenantId, roleId, and permissions to req.user
 *    so downstream controllers and services can use them
 *
 * WHY WE LOAD PERMISSIONS HERE:
 * The access token contains roleId (not the full permission list)
 * to keep it small. We do one quick DB lookup per request to get
 * the current permissions. This means if an admin changes a role's
 * permissions, the change takes effect immediately — not after the
 * user's token expires.
 *
 * If this becomes a performance concern, we can cache the
 * permissions in Redis with a short TTL.
 */

import { verifyAccessToken } from '../utils/tokens.js';
import Role from '../models/Role.js';
import AppError from '../utils/AppError.js';

const protect = async(req, _res, next) => {
    // 1. Extract the token from the Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AppError('Authentication required. Please provide a valid token.', 401);
    }

    const token = authHeader.split(' ')[1];

    // 2. Verify signature + expiry
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      const message =
        err.name === 'TokenExpiredError'
          ? 'Token has expired. Please refresh your session.'
          : 'Invalid token. Please log in again.';
      throw new AppError(message, 401);
    }

    // 3. Look up the role to get current permissions
    const role = await Role.findById(decoded.roleId).lean();
    if (!role) {
        throw new AppError('Role associated with this token no longer exists.', 401);
    }

    // 4. Attach user context for downstream handlers
    req.user = {
        userId: decoded.userId,
        tenantId: decoded.tenantId,
        roleId: decoded.roleId,
        permissions: role.permissions,
    };

    next();
};

export default protect;