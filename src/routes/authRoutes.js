/**
 * Auth routes — maps HTTP endpoints to controller functions.
 *
 * WHAT THIS DOES:
 * Defines the four auth endpoints (signup, login, refresh, logout)
 * and the invite + accept-invite + users endpoints.
 * and attaches the correct middleware to each:
 *
 * - signup and login get the AUTH rate limiter (15 req / 15 min)
 *   to slow down brute-force attempts.
 * - refresh does NOT require the protect middleware because the
 *   access token may have expired — that's the whole point of
 *   refreshing. It validates via the refresh token itself.
 * - logout does NOT require the protect middleware either. It takes
 *   the refresh token in the body and clears the stored hash.
 *   Always returns 200 so the client never sees an error on logout.
 * - invite requires USER_INVITE permission
 * - accept-invite is public (no token needed)
 * - users requires USER_MANAGE permission
 *
 * WHY A SEPARATE ROUTES FILE:
 * Routes are wiring — they connect URLs to handlers. Keeping them
 * separate from controllers and services means you can see every
 * endpoint at a glance without scrolling through handler functions.
 */

import { Router } from 'express';
import {
  signup,
  login,
  refreshTokens,
  logout,
  invite,
  acceptInvite,
  getUsers,
} from '../controllers/authController.js';
import { signupLimiter, loginLimiter } from '../middleware/rateLimiter.js';
import { requirePermission } from '../middleware/requirePermission.js';
import PERMISSIONS from '../constants/permissions.js';
import protect from '../middleware/protect.js';

const router = Router();

// Public routes (no token needed, but rate-limited)
router.post('/signup', signupLimiter, signup);
router.post('/login', loginLimiter, login);
router.post('/refresh', refreshTokens);
router.post('/logout', logout);

// Invite a user to the company (requires USER_INVITE permission)
router.post(
  '/users/invite',
  protect,
  requirePermission(PERMISSIONS.USER_INVITE),
  invite
);

// Accept an invite (public, no login required)
router.post('/auth/accept-invite', acceptInvite);

// List users in the caller's company (requires USER_MANAGE permission)
router.get(
  '/users',
  protect,
  requirePermission(PERMISSIONS.USER_MANAGE),
  getUsers
);

export default router;