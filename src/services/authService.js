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
 * 6. Sign and return access + refresh tokens
 *
 * LOGIN FLOW:
 * 1. Look up the Tenant by slug
 * 2. Find the User by { tenantId, email }
 * 3. Compare bcrypt hash
 * 4. Sign and return tokens
 *
 * REFRESH FLOW:
 * 1. Verify the refresh token's signature and expiry
 * 2. Check that its tokenVersion matches the user's current version
 *    (if not, the token was already rotated out → reject)
 * 3. Increment tokenVersion (invalidates the old refresh token)
 * 4. Sign and return NEW access + refresh tokens
 *
 * LOGOUT FLOW:
 * 1. Increment tokenVersion so the current refresh token is invalid
 */

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
 * Includes tokenVersion so we can detect reused (rotated-out) tokens.
 */
function buildRefreshPayload(user) {
  return {
    userId: user._id.toString(),
    tenantId: user.tenantId.toString(),
    tokenVersion: user.tokenVersion,
  };
}

/**
 * Signs both tokens and returns them as a plain object.
 */
function issueTokens(user, permissions) {
  const accessToken = signAccessToken(buildAccessPayload(user, permissions));
  const refreshToken = signRefreshToken(buildRefreshPayload(user));
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
  // 1. Generate slug and check for duplicates
  const slug = slugify(companyName);
  if (!slug) {
    throw new AppError('Company name produces an empty slug', 400);
  }

  const existingTenant = await Tenant.findOne({ slug });
  if (existingTenant) {
    throw new AppError(
      `A company with the slug "${slug}" already exists. Choose a different name.`,
      409,
    );
  }

  // 2. Create tenant
  const tenant = await Tenant.create({ name: companyName, slug });

  // 3. Create default roles for this tenant
  const [adminRole] = await Role.create([
    {
      tenantId: tenant._id,
      name: 'admin',
      permissions: ALL_PERMISSIONS,   // every permission
      isSystemRole: true,
    },
    {
      tenantId: tenant._id,
      name: 'member',
      permissions: MEMBER_PERMISSIONS,
      isSystemRole: true,
    },
  ]);

  // 4. Hash password (NEVER store plain text)
  const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

  // 5. Create the first user with the admin role
  const user = await User.create({
    tenantId: tenant._id,
    name: adminName,
    email,
    passwordHash,
    roleId: adminRole._id,
  });

  // 6. Issue tokens with admin permissions
  const tokens = issueTokens(user, adminRole.permissions);

  return {
    ...tokens,
    tenant: { id: tenant._id, name: tenant.name, slug: tenant.slug },
    user: { id: user._id, name: user.name, email: user.email },
  };
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

  // 6. Issue tokens with permissions
  const tokens = issueTokens(user, role.permissions);

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
 * Implements ROTATION: the old refresh token is invalidated by
 * incrementing tokenVersion.
 *
 * @param {string} refreshToken
 * @returns {{ accessToken, refreshToken }}
 */
export async function refresh(refreshToken) {
  // 1. Verify signature and expiry
  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError('Invalid or expired refresh token', 401);
  }

  // 2. Find the user
  const user = await User.findById(decoded.userId);
  if (!user || !user.isActive) {
    throw new AppError('Invalid or expired refresh token', 401);
  }

  // 3. Check token version (rotation guard)
  if (decoded.tokenVersion !== user.tokenVersion) {
    // Token was already used (rotated out) or tampered with.
    // This could mean someone stole and replayed an old refresh token.
    throw new AppError('Refresh token has been revoked', 401);
  }

  // 4. Rotate: increment version, invalidating the old refresh token
  user.tokenVersion += 1;
  await user.save();

  // 5. Issue fresh tokens (with the new tokenVersion baked in)
  const tokens = issueTokens(user);

  return tokens;
}

/**
 * Invalidates the current refresh token by bumping tokenVersion.
 *
 * @param {string} userId
 */
export async function logout(userId) {
  await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } });
}
