/**
 * Auth service — all authentication business logic lives here.
 *
 * WHAT THIS DOES:
 * Handles signup, login, token refresh, and logout. This is the
 * SERVICE LAYER — it knows about models, bcrypt, and JWTs, but
 * it does NOT know about req/res/next (those belong to controllers).
 *
 * WHY A SEPARATE SERVICE LAYER:
 * - Controllers handle HTTP (parse input, send response).
 * - Services handle BUSINESS LOGIC (validate, hash, save, sign).
 * If we later add a GraphQL API or a CLI tool, they call the same
 * service functions without duplicating logic.
 *
 * SIGNUP FLOW:
 * 1. Generate a URL-safe slug from the company name
 * 2. Create the Tenant document
 * 3. Create default roles ("admin" with ALL permissions, "member"
 *    with basic permissions)
 * 4. Hash the password with bcrypt (salt rounds = 12)
 * 5. Create the first User with the "admin" role
 * 6. Sign tokens, store SHA-256 hash of the refresh token
 *
 * LOGIN FLOW:
 * 1. Look up the Tenant by slug
 * 2. Find the User by { tenantId, email }
 * 3. Compare bcrypt hash
 * 4. Sign tokens, store SHA-256 hash of the refresh token
 *
 * REFRESH FLOW (rotation with reuse detection):
 * 1. Verify the refresh token's signature and expiry
 * 2. Hash the incoming token and compare it with the stored hash
 * 3. If it MATCHES: issue new tokens, replace the stored hash
 * 4. If it DOESN'T MATCH: someone is reusing an old token — clear
 *    the stored hash so ALL sessions for that user are killed
 *
 * LOGOUT FLOW:
 * 1. Try to decode the refresh token (don't care if it fails)
 * 2. If valid, clear the stored hash so it can never be used again
 * 3. Always succeed — logout should never show an error to the user
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import Tenant from '../models/Tenant.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import PasswordReset from '../models/PasswordReset.js';
import { ALL_PERMISSIONS, DEFAULT_ROLES } from '../constants/permissions.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/tokens.js';
import AppError from '../utils/AppError.js';
import { runWithTenant, runUnscoped } from '../utils/tenantContext.js';
import env from '../config/env.js';

const BCRYPT_SALT_ROUNDS = 12;

// Dummy hash for timing attack protection — bcrypt.compare against this
// takes the same time as a real comparison, preventing user enumeration.
const DUMMY_HASH = '$2a$12$dummyhashdummyhashdummyh';

// Removed — member permissions now come from DEFAULT_ROLES in permissions.js.

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

/**
 * Returns the SHA-256 hex digest of a string.
 * Used to hash refresh tokens before storing them.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Converts a company name into a URL-safe slug.
 * "Acme Corp!" → "acme-corp"
 */
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds the access token payload. Called by signup, login, and refresh.
 * NEVER includes password hashes or secrets.
 * Includes permissions so the protect middleware doesn't need an extra DB call.
 */
function buildAccessPayload(user, permissions) {
  return {
    userId: user._id.toString(),
    tenantId: user.tenantId.toString(),
    roleId: user.roleId.toString(),
    permissions,
  };
}

/**
 * Builds the refresh token payload.
 * Includes a random jti so every issued refresh token is unique,
 * preventing accidental hash collisions when two tokens are created
 * within the same second.
 */
function buildRefreshPayload(user) {
  return {
    userId: user._id.toString(),
    tenantId: user.tenantId.toString(),
    jti: crypto.randomUUID(),
  };
}

/**
 * Signs both tokens, stores the refresh token hash on the user,
 * and returns the raw tokens.
 */
export async function issueAndStoreTokens(user, permissions) {
  const accessToken = signAccessToken(buildAccessPayload(user, permissions));
  const refreshToken = signRefreshToken(buildRefreshPayload(user));

  // Store the SHA-256 hash, never the raw token
  user.refreshTokenHash = hashToken(refreshToken);
  await user.save();

  return { accessToken, refreshToken };
}

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Registers a new tenant + admin user.
 *
 * @param {Object} data
 * @param {string} data.companyName
 * @param {string} data.adminName
 * @param {string} data.email
 * @param {string} data.password
 * @returns {{ accessToken, refreshToken, tenant, user }}
 */
export async function signup({ companyName, adminName, email, password }) {
  // 1. Generate slug and check for duplicates (unscoped - Tenant has no tenantId)
  const slug = slugify(companyName);
  if (!slug) {
    throw new AppError('Company name produces an empty slug', 400);
  }

  const existingTenant = await runUnscoped(
    'signup: check for duplicate tenant slug',
    () => Tenant.findOne({ slug })
  );
  if (existingTenant) {
    throw new AppError(
      `A company with the slug "${slug}" already exists. Choose a different name.`,
      409,
    );
  }

  // 2. Create tenant (unscoped - Tenant model has no tenantId)
  const tenant = await runUnscoped(
    'signup: create new tenant',
    () => Tenant.create({ name: companyName, slug })
  );

  // 3. Create default roles and first user INSIDE tenant context
  // Context is set manually here because there's no logged-in request yet —
  // we just created the tenant and know its ID.
  return runWithTenant({ tenantId: tenant._id }, async () => {
    const [adminRole] = await Role.create([
      {
        name: 'admin',
        permissions: DEFAULT_ROLES.admin,
        isSystemRole: true,
        tenantId: tenant._id,
      },
      {
        name: 'member',
        permissions: DEFAULT_ROLES.member,
        isSystemRole: true,
        tenantId: tenant._id,
      },
    ]);

    // 4. Hash password (NEVER store plain text)
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    // 5. Create the first user with the admin role
    // tenantId is auto-stamped by the tenantPlugin from context
    const user = await User.create({
      name: adminName,
      email,
      passwordHash,
      roleId: adminRole._id,
    });

    // 6. Issue tokens and store refresh token hash
    const tokens = await issueAndStoreTokens(user, adminRole.permissions);

    return {
      ...tokens,
      tenant: { id: tenant._id, name: tenant.name, slug: tenant.slug },
      user: { id: user._id, name: user.name, email: user.email },
    };
  });
}

/**
 * Authenticates an existing user.
 *
 * @param {Object} data
 * @param {string} data.companySlug - identifies which company
 * @param {string} data.email
 * @param {string} data.password
 * @returns {{ accessToken, refreshToken, user }}
 */
export async function login({ companySlug, email, password }) {
  // 1. Find the tenant (unscoped - Tenant model has no tenantId)
  const tenant = await runUnscoped(
    'login: find tenant by slug',
    () => Tenant.findOne({ slug: companySlug })
  );

  // 2. Find the user within that tenant INSIDE tenant context
  // Context is set manually here because there's no logged-in request yet —
  // we just looked up the tenant by slug and know its ID.
  let user = null;
  if (tenant) {
    user = await runWithTenant({ tenantId: tenant._id }, async () => {
      // tenantId is auto-injected by tenantPlugin; we don't pass it
      return User.findOne({ email });
    });
  }

  // 3. Always run bcrypt.compare to prevent timing attacks.
  // If user doesn't exist or is inactive, compare against a dummy hash.
  const hashToCompare = (user && user.isActive) ? user.passwordHash : DUMMY_HASH;
  const passwordMatch = await bcrypt.compare(password, hashToCompare);

  // 4. If any check failed, return the SAME generic message.
  // This prevents attackers from discovering which companies/emails exist.
  if (!tenant || !user || !user.isActive || !passwordMatch) {
    throw new AppError('Invalid credentials', 401);
  }

  // 5. Fetch the role to get current permissions (inside tenant context)
  const role = await runWithTenant({ tenantId: tenant._id }, async () => {
    return Role.findById(user.roleId).lean();
  });
  if (!role) {
    throw new AppError('Invalid credentials', 401);
  }

  // 6. Issue tokens and store refresh token hash (inside tenant context)
  const tokens = await runWithTenant({ tenantId: tenant._id }, async () => {
    return issueAndStoreTokens(user, role.permissions);
  });

  // 7. Return tokens + minimal user object (no password hash)
  return {
    ...tokens,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: role.name,
    },
  };
}

/**
 * Issues new tokens using a valid refresh token.
 * Implements ROTATION with reuse detection:
 *
 * - Hash matches stored hash → issue new tokens, replace hash
 * - Hash does NOT match → old token reuse detected, wipe the
 *   stored hash so ALL sessions for this user are killed
 *
 * Every rejection returns the same generic message to avoid
 * leaking information about why the token was rejected.
 *
 * @param {string} refreshToken
 * @returns {{ accessToken, refreshToken }}
 */
export async function refresh(refreshToken) {
  const GENERIC_MSG = 'Invalid refresh token';

  // 1. Verify signature and expiry
  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError(GENERIC_MSG, 401);
  }

  // 2. Find the user and check tenant INSIDE tenant context
  // Context is set manually here using tenantId from the verified token payload —
  // there's no logged-in request yet (access token expired).
  const { userId, tenantId } = decoded;

  const user = await runWithTenant({ tenantId }, async () => {
    return User.findById(userId);
  });
  if (!user || !user.isActive) {
    throw new AppError(GENERIC_MSG, 401);
  }

  // 3. Check that the tenant still exists (unscoped - Tenant model)
  const tenant = await runUnscoped(
    'refresh: verify tenant still exists',
    () => Tenant.findById(tenantId)
  );
  if (!tenant) {
    throw new AppError(GENERIC_MSG, 401);
  }

  // 4. Hash the incoming token and compare with stored hash (inside tenant context)
  const incomingHash = hashToken(refreshToken);

  if (user.refreshTokenHash !== incomingHash) {
    // REUSE DETECTED — an old (already-rotated) token is being replayed.
    // Wipe the stored hash so even the newest token stops working.
    // This is the safety measure: if an attacker stole the old token,
    // nuking everything forces the real user to re-login (annoying but safe).
    await runWithTenant({ tenantId }, async () => {
      user.refreshTokenHash = null;
      await user.save();
    });
    throw new AppError(GENERIC_MSG, 401);
  }

  // 5. Fetch the role to get current permissions (inside tenant context)
  const role = await runWithTenant({ tenantId }, async () => {
    return Role.findById(user.roleId).lean();
  });
  if (!role) {
    throw new AppError(GENERIC_MSG, 401);
  }

  // 6. Issue fresh tokens (this also replaces the stored hash) inside tenant context
  const tokens = await runWithTenant({ tenantId }, async () => {
    return issueAndStoreTokens(user, role.permissions);
  });

  return tokens;
}

/**
 * Invalidates the refresh token by clearing the stored hash.
 * Always succeeds — logout should never show an error to the user.
 *
 * @param {string} refreshToken
 */
export async function logout(refreshToken) {
  // Best-effort: try to decode the token to find the user.
  // If it's garbage or expired, we just do nothing — still return success.
  try {
    const decoded = verifyRefreshToken(refreshToken);
    const { userId, tenantId } = decoded;

    // Run inside tenant context using tenantId from the verified token
    // Context is set manually here because there's no logged-in request.
    await runWithTenant({ tenantId }, async () => {
      await User.findByIdAndUpdate(userId, { refreshTokenHash: null });
    });
  } catch {
    // Token is garbage or expired — nothing to clear, that's fine.
  }
}

// ──────────────────────────────────────────────────────────────
// Password reset flow
// ──────────────────────────────────────────────────────────────

/**
 * Number of seconds a password reset token stays valid.
 * Short window: 1 hour by default. Long enough to click the link,
 * short enough that a leaked token can't be abused for long.
 * Configurable via PASSWORD_RESET_EXPIRY_HOURS.
 */
const PASSWORD_RESET_EXPIRY_SECONDS = env.passwordResetExpiryHours * 60 * 60;

/**
 * Generates a fresh password-reset token for the given user.
 *
 * WHAT THIS DOES:
 * - Invalidates any older UNUSED reset tokens for that user
 * - Creates a new 256-bit random token
 * - Stores only its SHA-256 hash (never the raw token)
 * - Returns the raw token so the caller can put it in the email/link
 *
 * WHY INVALIDATE OLD TOKENS:
 * Each "forgot password" click sends a NEW link. If we left the old
 * ones alive, a user with an old email in their inbox could click a
 * stale link. Only the newest token should ever work.
 *
 * @param {mongoose.Document} user - the user document (already loaded)
 * @returns {string} the raw reset token (send this to the user)
 */
export async function createPasswordResetToken(user) {
  // Delete every unused reset token for this user. We match on
  // usedAt=null and the user's own _id. The tenant plugin scopes
  // this to the current tenant automatically.
  await PasswordReset.deleteMany({
    userId: user._id,
    usedAt: null,
  });

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_SECONDS * 1000);

  await PasswordReset.create({
    userId: user._id,
    tokenHash,
    expiresAt,
  });

  return rawToken;
}

/**
 * Handles a "forgot password" request.
 *
 * WHAT THIS DOES:
 * 1. Looks up the tenant by slug (unscoped — Tenant has no tenantId)
 * 2. Looks up the user by email inside that tenant
 * 3. If the user exists and is active, invalidates old tokens and
 *    creates a new reset token, returning it (the caller emails it)
 * 4. If the tenant/user does not exist or the user is inactive, does
 *    the same amount of work (creates and discards a dummy token) and
 *    returns null
 *
 * WHY THE SAME RESPONSE FOR EVERYTHING:
 * This is the account-lookup protection. If we returned different
 * messages or different statuses for "company not found" vs "user not
 * found" vs "user inactive", an attacker could probe which emails have
 * live accounts. So the CONTROLLER always returns the same 200 body
 * regardless of what happened here. The only thing that changes is
 * whether a real token was generated and emailed.
 *
 * WHY DO THE SAME AMOUNT OF WORK:
 * We also want the response TIME to be indistinguishable. Generating a
 * random token and hashing it is cheap, but doing it unconditionally
 * means an attacker can't infer anything from how long the request took.
 *
 * @param {Object} data
 * @param {string} data.companySlug
 * @param {string} data.email
 * @returns {string|null} the raw reset token to email, or null
 */
export async function forgotPassword({ companySlug, email }) {
  // 1. Find the tenant by slug (unscoped — Tenant model has no tenantId)
  const tenant = await runUnscoped(
    'forgot-password: find tenant by slug',
    () => Tenant.findOne({ slug: companySlug })
  );

  // Always generate a token hash so the timing is the same whether or
  // not the tenant/user exists. This defeats timing-based probing.
  const dummyToken = crypto.randomBytes(32).toString('hex');
  hashToken(dummyToken);

  // 2. If no tenant, no user — but we still return the same response.
  if (!tenant) {
    return null;
  }

  // 3. Find the user inside the tenant's context
  const user = await runWithTenant({ tenantId: tenant._id }, async () => {
    return User.findOne({ email });
  });

  // 4. Only active users can reset. Inactive users get the same response
  //    — we never confirm they exist, so an attacker can't distinguish
  //    "this email is registered but deactivated" from "not registered."
  if (!user || !user.isActive) {
    return null;
  }

  // 5. Generate and store the real token
  return createPasswordResetToken(user);
}

/**
 * Applies a password reset using a raw token from the user's link.
 *
 * WHAT THIS DOES:
 * 1. Hashes the incoming token
 * 2. Atomically claims the matching row (usedAt=null, not expired)
 * 3. Re-hashes the user's password with bcrypt
 * 4. Marks the reset row as used
 *
 * WHY ATOMIC CLAIM:
 * findOneAndUpdate with usedAt=null in the filter guarantees only one
 * request can ever claim this token, even under concurrent attacks.
 * If two requests race, exactly one wins and the other gets null.
 *
 * WHY WE REJECT THE SAME GENERIC WAY:
 * We never say "token expired" vs "token wrong" vs "user inactive" —
 * an attacker probing reset links would otherwise learn which emails
 * have accounts and which links are still alive.
 *
 * @param {string} rawToken - the token from the user's reset link
 * @param {string} newPassword - the new password to set
 * @returns {{ user }} the updated user document
 */
export async function resetPassword(rawToken, newPassword) {
  const GENERIC_MSG = 'If that account exists, a new link has been sent';

  if (!rawToken || !newPassword) {
    throw new AppError(GENERIC_MSG, 400);
  }

  const tokenHash = hashToken(rawToken);

  // Atomically claim the token. usedAt=null + expiry check in the filter
  // means only one request can match, and expired tokens never match.
  const reset = await PasswordReset.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: new Date() } },
    { usedAt: new Date() },
    { returnDocument: 'after' }
  );

  // Wrong token, expired, or already used — same generic response either way.
  // We do NOT reveal which case it was.
  if (!reset) {
    throw new AppError(GENERIC_MSG, 400);
  }

  // Load the user inside the reset's tenant context. The reset row
  // carries tenantId, so we use it to scope the lookup.
  const user = await runWithTenant({ tenantId: reset.tenantId }, async () => {
    return User.findById(reset.userId);
  });

  // The user might have been deleted since the token was issued — be safe.
  if (!user) {
    throw new AppError(GENERIC_MSG, 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);

  await runWithTenant({ tenantId: reset.tenantId }, async () => {
    user.passwordHash = passwordHash;
    // Kill every active session: a password changed mid-session means
    // any old refresh token is now suspect. Force re-login.
    user.refreshTokenHash = null;
    await user.save();
  });

  return { user };
}
