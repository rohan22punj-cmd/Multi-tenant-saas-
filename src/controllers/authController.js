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
} from '../services/authService.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';

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
 * Body: { tenantSlug, email, password }
 * Returns: { accessToken, refreshToken }
 *
 * WHY tenantSlug IS REQUIRED:
 * Email is unique per-tenant, not globally. Two different companies
 * can have "alice@example.com." Requiring the tenant slug tells us
 * which company the user is logging into — just like Slack asks
 * "which workspace?" before asking for your email.
 */
export const login = asyncHandler(async (req, res) => {
  const { tenantSlug, email, password } = req.body;

  if (!tenantSlug || !email || !password) {
    throw new AppError('tenantSlug, email, and password are all required', 400);
  }

  const tokens = await loginService({ tenantSlug, email, password });

  res.status(200).json({
    status: 'success',
    data: tokens,
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
 * Requires a valid access token (protect middleware).
 * Invalidates the user's refresh token by bumping tokenVersion.
 */
export const logout = asyncHandler(async (req, res) => {
  await logoutService(req.user.userId);

  res.status(200).json({
    status: 'success',
    message: 'Logged out successfully',
  });
});
