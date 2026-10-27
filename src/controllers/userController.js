/**
 * User management controller — deactivate and reactivate users.
 *
 * WHAT THIS DOES:
 * Two endpoints that let an admin (or any user with USER_MANAGE) flip
 * another user's isActive flag. The business rules here prevent two
 * dangerous scenarios:
 *
 *   1. Self-deactivation — you could lock yourself out.
 *   2. Last-admin deactivation — the company would have no way to recover
 *      without direct database access. We count active users whose role
 *      has the USER_MANAGE permission; if only one remains, we block the
 *      request with 409.
 *   3. Privilege escalation via deactivation — you should not be able to
 *      deactivate someone who can do things you cannot. That would let a
 *      low-power user sideline a higher-power one.
 *
 * WHY WE WIPE THE REFRESH TOKEN ON DEACTIVATION:
 * The access token is stateless — we do NOT check the database on every
 * request (that would kill performance). A deactivated user's access token
 * stays valid for up to 15 minutes until it expires naturally. That is an
 * accepted trade-off. However, we CAN cut off the NEXT session immediately:
 * clearing refreshTokenHash means the user cannot exchange their refresh
 * token for a new access token. So worst case, a deactivated user has 15
 * minutes of residual access, then they are out.
 *   -- ponytail: access tokens are still valid up to 15 min post-deactivation;
 *      add a token revocation list (e.g. Redis blocklist) if near-instant
 *      cutoff is required.
 *
 * WHY THE LAST-ADMIN RULE EXISTS:
 * If an admin deactivates the only other admin, no one with USER_MANAGE can
 * reactivate anyone, and the company is effectively locked out. We prevent
 * this by refusing to deactivate the last active user whose role has the
 * USER_MANAGE permission.
 */

import mongoose from 'mongoose';
import User from '../models/User.js';
import Role from '../models/Role.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { PERMISSIONS } from '../constants/permissions.js';

/**
 * PATCH /api/users/:id/deactivate
 *
 * Sets isActive = false and clears refreshTokenHash.
 * Guards: self-deactivation (403), last admin (409), privilege (403).
 */
export const deactivate = asyncHandler(async (req, res) => {
  const targetId = req.params.id;
  const callerId = req.user.userId;

  // Rule a: cannot deactivate yourself
  if (targetId === callerId) {
    throw new AppError('Forbidden', 403);
  }

  // tenantPlugin scopes this to the caller's tenant — another company's id → null → 404
  const target = await User.findById(targetId);
  if (!target) {
    throw new AppError('User not found', 404);
  }

  // Rule c: privilege check — caller must have every permission the target's role has
  const targetRole = await Role.findById(target.roleId).lean();
  if (targetRole) {
    const callerPerms = new Set(req.user.permissions);
    const hasPrivilegeGap = targetRole.permissions.some((p) => !callerPerms.has(p));
    if (hasPrivilegeGap) {
      throw new AppError('Forbidden', 403);
    }
  }

  // Rule b: cannot deactivate the last active user who holds USER_MANAGE
  // We only need to check this if the target is currently active.
  if (target.isActive) {
    // Find all roles in this tenant that have USER_MANAGE
    const adminRoles = await Role.find({ permissions: PERMISSIONS.USER_MANAGE }).lean();
    const adminRoleIds = adminRoles.map((r) => r._id.toString());

    // Count active users (excluding the one we're about to deactivate) with an admin role
    const remainingAdminCount = await User.countDocuments({
      _id: { $ne: target._id },
      isActive: true,
      roleId: { $in: adminRoleIds },
    });

    if (remainingAdminCount === 0 && adminRoleIds.includes(target.roleId.toString())) {
      throw new AppError('Cannot deactivate the last admin', 409);
    }
  }

  // All checks passed — deactivate and cut off future refresh token use
  target.isActive = false;
  target.refreshTokenHash = null;
  await target.save();

  res.status(200).json({ id: target._id, isActive: target.isActive });
});

/**
 * PATCH /api/users/:id/reactivate
 *
 * Sets isActive = true. Idempotent — already-active users return 200.
 */
export const reactivate = asyncHandler(async (req, res) => {
  const targetId = req.params.id;

  // tenantPlugin scopes this to the caller's tenant — another company's id → null → 404
  const target = await User.findById(targetId);
  if (!target) {
    throw new AppError('User not found', 404);
  }

  target.isActive = true;
  await target.save();

  res.status(200).json({ id: target._id, isActive: target.isActive });
});
