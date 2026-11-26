/**
 * Role Controller — HTTP layer for custom role management.
 *
 * WHAT THIS DOES:
 * CRUD operations for custom roles within a tenant. All endpoints require
 * USER_MANAGE permission and protect middleware (valid JWT).
 *
 * PRIVILEGE RULES (reused from invite/changeRole):
 * - You cannot create a role with permissions you don't have
 * - You cannot edit/delete a role that has permissions you lack
 * - System roles (admin, member) cannot be edited or deleted
 */

import Role from '../models/Role.js';
import User from '../models/User.js';
import ActivityLog from '../models/ActivityLog.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ALL_PERMISSIONS, PERMISSIONS } from '../constants/permissions.js';
import { revokeUser } from '../services/revocation.service.js';
import { runWithTenant } from '../utils/tenantContext.js';

/**
 * Validates role input: name length, permissions array content.
 */
function validateRoleInput(name, permissions) {
  if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 40) {
    throw new AppError('Role name must be 2-40 characters', 400);
  }

  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new AppError('Permissions must be a non-empty array', 400);
  }

  // Check for duplicates
  const uniquePerms = [...new Set(permissions)];
  if (uniquePerms.length !== permissions.length) {
    throw new AppError('Permissions array must not contain duplicate keys', 400);
  }

  // Validate every permission key exists in ALL_PERMISSIONS
  const invalidPerms = permissions.filter(p => !ALL_PERMISSIONS.includes(p));
  if (invalidPerms.length > 0) {
    throw new AppError(`Invalid permission key(s): ${invalidPerms.join(', ')}`, 400);
  }

  return { name: name.trim(), permissions: uniquePerms };
}

/**
 * Privilege check: caller must have ALL permissions in target set.
 * Returns true if caller has all target permissions.
 */
function callerHasAllPermissions(callerPerms, targetPerms) {
  const callerSet = new Set(callerPerms);
  return targetPerms.every(p => callerSet.has(p));
}

/**
 * Privilege check: target role has any permission caller lacks.
 * Returns true if there's a privilege gap (caller cannot manage this role).
 */
function hasPrivilegeGap(callerPerms, targetPerms) {
  const callerSet = new Set(callerPerms);
  return targetPerms.some(p => !callerSet.has(p));
}

/**
 * GET /api/roles
 * Returns all roles in the caller's company with user counts.
 */
export const listRoles = asyncHandler(async (req, res) => {
  const roles = await Role.find({}).lean();

  // Add user count for each role
  const rolesWithCount = await Promise.all(
    roles.map(async (role) => {
      const userCount = await User.countDocuments({ roleId: role._id });
      return { ...role, userCount };
    })
  );

  res.status(200).json({ status: 'success', data: rolesWithCount });
});

/**
 * GET /api/permissions
 * Returns the fixed permission list from constants for frontend checkboxes.
 */
export const listPermissions = asyncHandler(async (_req, res) => {
  const permissions = Object.entries(PERMISSIONS).map(([key, value]) => ({
    key,
    value,
    category: key.split('_')[0].toLowerCase(), // project, task, user, billing
  }));

  res.status(200).json({ status: 'success', data: permissions });
});

/**
 * POST /api/roles
 * Creates a custom role with specified permissions.
 * Privilege rule: caller must have ALL permissions they're assigning.
 * Name must be unique per tenant (case-insensitive).
 */
export const createRole = asyncHandler(async (req, res) => {
  const { name, permissions } = req.body;
  const validated = validateRoleInput(name, permissions);

  // Privilege check: caller must have all permissions they're assigning
  if (!callerHasAllPermissions(req.user.permissions, validated.permissions)) {
    throw new AppError('Forbidden: you cannot assign permissions you do not have', 403);
  }

  try {
    const role = await Role.create({
      name: validated.name,
      permissions: validated.permissions,
      isSystemRole: false, // never accepted from body
    });

    // Log activity
    await ActivityLog.create({
      tenantId: req.user.tenantId,
      userId: req.user.userId,
      action: 'role.created',
      entityType: 'role',
      entityId: role._id,
      meta: { name: role.name, permissions: role.permissions },
    });

    res.status(201).json({ status: 'success', data: role });
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key on tenantId + name (case-insensitive unique index)
      throw new AppError('Role already exists', 409);
    }
    throw err;
  }
});

/**
 * PATCH /api/roles/:id
 * Updates a custom role's name and/or permissions.
 * System roles (isSystemRole: true) cannot be edited.
 * Privilege rules:
 * - Cannot add permissions you don't have
 * - Cannot edit a role that currently has permissions you lack
 */
export const updateRole = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, permissions } = req.body;

  // Validate roleId format
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('Invalid role id', 400);
  }

  // Find role (tenant plugin scopes to current tenant)
  const role = await Role.findById(id);
  if (!role) {
    throw new AppError('Role not found', 404);
  }

  // System roles cannot be edited
  if (role.isSystemRole) {
    throw new AppError('System roles cannot be changed', 403);
  }

  // Privilege check: caller must have all permissions the role CURRENTLY has
  if (hasPrivilegeGap(req.user.permissions, role.permissions)) {
    throw new AppError('Forbidden: you cannot manage a role with more permissions than you have', 403);
  }

  const updates = {};
  const oldName = role.name;
  const oldPermissions = [...role.permissions];

  // Validate and apply name change
  if (name !== undefined) {
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 40) {
      throw new AppError('Role name must be 2-40 characters', 400);
    }
    updates.name = name.trim();
  }

  // Validate and apply permissions change
  if (permissions !== undefined) {
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new AppError('Permissions must be a non-empty array', 400);
    }
    const uniquePerms = [...new Set(permissions)];
    if (uniquePerms.length !== permissions.length) {
      throw new AppError('Permissions array must not contain duplicate keys', 400);
    }
    const invalidPerms = permissions.filter(p => !ALL_PERMISSIONS.includes(p));
    if (invalidPerms.length > 0) {
      throw new AppError(`Invalid permission key(s): ${invalidPerms.join(', ')}`, 400);
    }

    // Privilege check: cannot add permissions you don't have
    const newPerms = uniquePerms.filter(p => !role.permissions.includes(p));
    if (newPerms.length > 0 && !callerHasAllPermissions(req.user.permissions, newPerms)) {
      throw new AppError('Forbidden: you cannot add permissions you do not have', 403);
    }

    updates.permissions = uniquePerms;
  }

  // Apply updates
  Object.assign(role, updates);
  await role.save();

  // If permissions changed, revoke all users with this role to force fresh tokens
  let revokedCount = 0;
  if (permissions !== undefined && JSON.stringify(oldPermissions) !== JSON.stringify(role.permissions)) {
    const usersWithRole = await User.find({ roleId: role._id }).lean();
    revokedCount = usersWithRole.length;

    // Clear refresh tokens and revoke access tokens for all affected users
    for (const user of usersWithRole) {
      await runWithTenant({ tenantId: req.user.tenantId }, async () => {
        await User.findByIdAndUpdate(user._id, { refreshTokenHash: null });
      });
      await revokeUser(req.user.tenantId, user._id.toString());
    }
  }

  // Log activity
  const meta = { oldName, newName: role.name };
  if (permissions !== undefined) {
    const added = role.permissions.filter(p => !oldPermissions.includes(p));
    const removed = oldPermissions.filter(p => !role.permissions.includes(p));
    if (added.length || removed.length) {
      meta.addedPermissions = added;
      meta.removedPermissions = removed;
    }
  }

  await ActivityLog.create({
    tenantId: req.user.tenantId,
    userId: req.user.userId,
    action: 'role.updated',
    entityType: 'role',
    entityId: role._id,
    meta,
  });

  res.status(200).json({ status: 'success', data: { role, usersAffected: revokedCount } });
});

/**
 * DELETE /api/roles/:id
 * Deletes a custom role.
 * System roles cannot be deleted.
 * Role must have no users assigned.
 * Privilege rule: cannot delete a role with permissions you lack.
 */
export const deleteRole = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new AppError('Invalid role id', 400);
  }

  const role = await Role.findById(id);
  if (!role) {
    throw new AppError('Role not found', 404);
  }

  // System roles cannot be deleted
  if (role.isSystemRole) {
    throw new AppError('System roles cannot be deleted', 403);
  }

  // Privilege check: caller must have all permissions the role has
  if (hasPrivilegeGap(req.user.permissions, role.permissions)) {
    throw new AppError('Forbidden: you cannot delete a role with more permissions than you have', 403);
  }

  // Check if role has users assigned (must be done with tenant context)
  const userCount = await User.countDocuments({ roleId: role._id });
  if (userCount > 0) {
    throw new AppError('Role is in use', 409);
  }

  await role.deleteOne();

  // Log activity
  await ActivityLog.create({
    tenantId: req.user.tenantId,
    userId: req.user.userId,
    action: 'role.deleted',
    entityType: 'role',
    entityId: role._id,
    meta: { name: role.name, removedPermissions: role.permissions },
  });

  res.status(200).json({ status: 'success', message: 'Role deleted' });
});

// Import mongoose at the top
import mongoose from 'mongoose';

export default { listRoles, listPermissions, createRole, updateRole, deleteRole };