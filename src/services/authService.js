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
import { ALL_PERMISSIONS } from '../models/permissions.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/tokens.js';
import AppError from '../utils/AppError.js';
import { runWithTenant, runUnscoped } from '../utils/tenantContext.js';

const BCRYPT_SALT_ROUNDS = 12;

// Dummy hash for timing attack protection — bcrypt.compare against this
// takes the same time as a real comparison, preventing user enumeration.
const DUMMY_HASH = '$2a$12$dummyhashdummyhashdummyh';

/**
 * The "member" role gets read-only access to projects and tasks
 * plus the ability to create and update tasks (a typical team member).
 */
const MEMBER_PERMISSIONS = [
  'project:read',
  'task:create',
  'task:read',
  'task:update',
];

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
async function issueAndStoreTokens(user, permissions) {
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
        permissions: ALL_PERMISSIONS,   // every permission
        isSystemRole: true,
      },
      {
        name: 'member',
        permissions: MEMBER_PERMISSIONS,
        isSystemRole: true,
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
  // 1. Find the tenant
  const tenant = await Tenant.findOne({ slug: companySlug });

  // 2. Find the user within that tenant (if tenant exists)
  let user = null;
  if (tenant) {
    user = await User.findOne({ tenantId: tenant._id, email });
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

  // 5. Fetch the role to get current permissions
  const role = await Role.findById(user.roleId).lean();
  if (!role) {
    throw new AppError('Invalid credentials', 401);
  }

  // 6. Issue tokens and store refresh token hash
  const tokens = await issueAndStoreTokens(user, role.permissions);

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

  // 2. Find the user
  const user = await User.findById(decoded.userId);
  if (!user || !user.isActive) {
    throw new AppError(GENERIC_MSG, 401);
  }

  // 3. Check that the tenant still exists
  const tenant = await Tenant.findById(user.tenantId);
  if (!tenant) {
    throw new AppError(GENERIC_MSG, 401);
  }

  // 4. Hash the incoming token and compare with stored hash
  const incomingHash = hashToken(refreshToken);

  if (user.refreshTokenHash !== incomingHash) {
    // REUSE DETECTED — an old (already-rotated) token is being replayed.
    // Wipe the stored hash so even the newest token stops working.
    // This is the safety measure: if an attacker stole the old token,
    // nuking everything forces the real user to re-login (annoying but safe).
    user.refreshTokenHash = null;
    await user.save();
    throw new AppError(GENERIC_MSG, 401);
  }

  // 5. Fetch the role to get current permissions
  const role = await Role.findById(user.roleId).lean();
  if (!role) {
    throw new AppError(GENERIC_MSG, 401);
  }

  // 6. Issue fresh tokens (this also replaces the stored hash)
  const tokens = await issueAndStoreTokens(user, role.permissions);

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
    await User.findByIdAndUpdate(decoded.userId, { refreshTokenHash: null });
  } catch {
    // Token is garbage or expired — nothing to clear, that's fine.
  }
}
