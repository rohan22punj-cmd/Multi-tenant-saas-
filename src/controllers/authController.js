/**
 * Auth controller — HTTP layer for authentication endpoints.
 *
 * WHAT THIS DOES:
 * Each function here maps to one Express route. It reads data from
 * the request, calls the corresponding authService function, and
 * sends back a JSON response. There is NO business logic here —
 * that all lives in authService.js.
 *
 * WHY THIS PATTERN (thin controller → fat service):
 * - Easy to test: service functions can be unit-tested without HTTP.
 * - Reusable: if we add GraphQL or a CLI later, they call the same
 *   service functions.
 * - Clear separation: controllers handle "HTTP stuff" (status codes,
 *   headers, body parsing), services handle "business stuff."
 */

import {
  signup as signupService,
  login as loginService,
  refresh as refreshService,
  logout as logoutService,
  issueAndStoreTokens,
} from '../services/authService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import Invite from '../models/Invite.js';
import bcrypt from 'bcryptjs';
import Tenant from '../models/Tenant.js';
import config from '../config/env.js';
import crypto from 'node:crypto';

/**
 * POST /api/auth/signup
 *
 * Body: { companyName, adminName, email, password }
 * Returns: { accessToken, refreshToken, tenant, user }
 */
export const signup = asyncHandler(async (req, res) => {
  const { companyName, adminName, email, password } = req.body;

  // Basic presence validation (more detailed validation can be
  // added via a validation middleware later)
  if (!companyName || !adminName || !email || !password) {
    throw new AppError(
      'companyName, adminName, email, and password are all required',
      400,
    );
  }

  const result = await signupService({ companyName, adminName, email, password });

  res.status(201).json({
    status: 'success',
    data: result,
  });
});

/**
 * POST /api/auth/login
 *
 * Body: { companySlug, email, password }
 * Returns: { accessToken, refreshToken, user }
 *
 * WHY companySlug IS REQUIRED:
 * Email is unique per-tenant, not globally. Two different companies
 * can have "alice@example.com." Requiring the company slug tells us
 * which company the user is logging into — just like Slack asks
 * "which workspace?" before asking for your email.
 */
export const login = asyncHandler(async (req, res) => {
  const { companySlug, email, password } = req.body;

  if (!companySlug || !email || !password) {
    throw new AppError('companySlug, email, and password are all required', 400);
  }

  const result = await loginService({ companySlug, email, password });

  res.status(200).json({
    status: 'success',
    data: result,
  });
});

/**
 * POST /api/auth/refresh
 *
 * Body: { refreshToken }
 * Returns: { accessToken, refreshToken } (both NEW — rotation)
 */
export const refreshTokens = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    throw new AppError('refreshToken is required', 400);
  }

  const tokens = await refreshService(refreshToken);

  res.status(200).json({
    status: 'success',
    data: tokens,
  });
});

/**
 * POST /api/auth/logout
 *
 * Body: { refreshToken }
 * Always returns 200 — logout should never show an error.
 * Clears the stored hash so the refresh token can never be reused.
 */
export const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  // Even if refreshToken is missing or garbage, we return 200.
  // The service handles this gracefully.
  await logoutService(refreshToken || '');

  res.status(200).json({
    status: 'success',
    message: 'Logged out successfully',
  });
});

/**
 * POST /api/auth/accept-invite
 *
 * Body: { companySlug, token, name, password }
 * Public route — no login required.
 *
 * On success: create the User with the invite's email and roleId,
 * hash the password with bcrypt, mark the invite acceptedAt,
 * and return the same shape as login (access token, refresh token,
 * small user object). Save the refresh token hash like login does.
 *
 * Reject with the same generic 400 "Invalid or expired invite" for every
 * failure (wrong company, wrong token, expired, already used), so attackers
 * learn nothing.
 *
 * Atomic claim: use findOneAndUpdate with acceptedAt=null to claim the
 * invite first, so the same invite cannot be accepted twice even with
 * two concurrent requests.
 *
 * Rate limit: same as login limiter.
 */
export const acceptInvite = asyncHandler(async (req, res) => {
  const { companySlug, token, name, password } = req.body;

  if (!companySlug || !token || !name || !password) {
    throw new AppError('Invalid or expired invite', 400);
  }

  // Find the tenant by slug (unscoped)
  const tenant = await Tenant.findOne({ slug: companySlug });
  if (!tenant) {
    throw new AppError('Invalid or expired invite', 400);
  }

  // Inside tenant context, find the invite by token hash and claim it atomically
  const userId = req.user ? req.user.userId : undefined; // we might not have a user since this is public

  // Use findOneAndUpdate with acceptedAt=null to atomically claim the invite
  // This prevents double-acceptance even with concurrent requests
  const invite = await Invite.findOneAndUpdate(
    { tokenHash: crypto.createHash('sha256').update(token).digest('hex'), acceptedAt: null, expiresAt: { $gt: new Date() } },
    { acceptedAt: new Date(), $set: { tenantId: tenant._id } }, // stamp tenantId
    { new: true }
  );

  if (!invite) {
    // Either wrong token, expired, or already used — same generic message
    throw new AppError('Invalid or expired invite', 400);
  }

  // Now create the user inside the tenant context
  const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

  const user = await User.create({
    name,
    email: invite.email,
    passwordHash,
    roleId: invite.roleId,
    tenantId: tenant._id,
  });

  // Issue tokens like login does
  const tokens = await issueAndStoreTokens(user, invite.role.permissions);

  // Mark the invite fully accepted (already done by findOneAndUpdate above)
  // but also clear the tokenHash optionally

  res.status(200).json({
    status: 'success',
    data: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: invite.role.name,
      },
    },
  });
});

/**
 * GET /api/users
 *
 * Body: none
 * Protected by protect.js + requirePermission(PERMISSIONS.USER_MANAGE)
 *
 * Returns the list of users in the caller's company (id, name, email, role name, isActive).
 * Never the password hash or refresh token hash.
 *
 * This gives us a way to see the result of an invite.
 */
export const getUsers = asyncHandler(async (req, res) => {
  // The tenant plugin already scoped the query to the caller's company
  const users = await User.find({}).select('-passwordHash -refreshTokenHash');

  // Populate role name
  const usersWithRole = await Promise.all(
    users.map(async (user) => {
      const role = await Role.findById(user.roleId).select('name');
      return {
        id: user._id,
        name: user.name,
        email: user.email,
        role: role ? role.name : 'unknown',
        isActive: user.isActive,
      };
    })
  );

  res.status(200).json({
    status: 'success',
    data: usersWithRole,
  });
});

/**
 * POST /api/users/invite
 *
 * Body: { email, roleId }
 * Returns: { inviteId, email, expiresAt, inviteLink }
 *
 * Privilege rule: an inviter cannot invite someone into a role that has
 * any permission the inviter does not have themselves. If they try, return
 * 403 "Forbidden". This stops a low-power user from creating a more powerful account.
 *
 * If a user with that email already exists in this company, return 409 "User already exists".
 * If a pending (not accepted, not expired) invite for that email already exists, replace it
 * with a new one instead of creating a duplicate.
 *
 * Rate limit: same as login limiter (implicitly, via the global /api rate limiter).
 */
export const invite = asyncHandler(async (req, res) => {
  const { email, roleId } = req.body;

  if (!email || !roleId) {
    throw new AppError('email and roleId are required', 400);
  }

  // Get the caller's user permissions (set by protect middleware)
  const callerPermissions = req.user.permissions;

  // Find the role the caller is inviting into, within the caller's own company
  // The tenant plugin ensures we only find roles from the caller's company
  const role = await Role.findById(roleId);
  if (!role) {
    throw new AppError('Role not found', 404);
  }

  // Check privilege rule: inviter must have ALL the permissions that the target role has
  const rolePermissionSet = new Set(role.permissions);
  const inviterPermissionSet = new Set(callerPermissions);
  const hasExtraPermission = [...rolePermissionSet].some(
    (perm) => !inviterPermissionSet.has(perm)
  );

  if (hasExtraPermission) {
    throw new AppError('Forbidden', 403);
  }

  // Check if a user with that email already exists in this company
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new AppError('User already exists', 409);
  }

  // Check if there's a pending (not accepted, not expired) invite for that email
  const existingInvite = await Invite.findOne({ email, acceptedAt: null, expiresAt: { $gt: new Date() } });
  if (existingInvite) {
    // Replace it with a new one — update the roleId, invitedBy, token, expiry
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    existingInvite.roleId = roleId;
    existingInvite.invitedBy = req.user.userId;
    existingInvite.tokenHash = tokenHash;
    existingInvite.expiresAt = new Date(Date.now() + config.inviteExpiryDays * 24 * 60 * 60 * 1000);
    await existingInvite.save();

    const inviteLink = `${process.env.APP_URL}/accept-invite?company=${req.user.slug}&token=${rawToken}`;

    console.debug('Invite link generated (replacement):', inviteLink);

    res.status(201).json({
      inviteId: existingInvite._id,
      email: existingInvite.email,
      expiresAt: existingInvite.expiresAt,
      inviteLink,
    });
    return;
  }

  // Create a new invite
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const expiresAt = new Date(Date.now() + config.inviteExpiryDays * 24 * 60 * 60 * 1000);

  const invite = await Invite.create({
    tenantId: req.user.tenantId,
    email,
    roleId,
    invitedBy: req.user.userId,
    tokenHash,
    expiresAt,
  });

  const inviteLink = `${process.env.APP_URL}/accept-invite?company=${req.user.slug}&token=${rawToken}`;

  console.debug('Invite link generated:', inviteLink);

  res.status(201).json({
    inviteId: invite._id,
    email: invite.email,
    expiresAt: invite.expiresAt,
    inviteLink,
  });
});
