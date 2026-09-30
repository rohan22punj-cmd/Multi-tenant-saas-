/**
 * Auth routes — maps HTTP endpoints to controller functions.
 *
 * WHAT THIS DOES:
 * Defines the four auth endpoints (signup, login, refresh, logout)
 * and attaches the correct middleware to each:
 *
 * - signup and login get the AUTH rate limiter (15 req / 15 min)
 *   to slow down brute-force attempts.
 * - logout sits behind the protect middleware because you need
 *   a valid access token to log out (otherwise anyone could
 *   invalidate someone else's session).
 * - refresh does NOT require the protect middleware because the
 *   access token may have expired — that's the whole point of
 *   refreshing. It validates via the refresh token itself.
 *
 * WHY A SEPARATE ROUTES FILE:
 * Routes are wiring — they connect URLs to handlers. Keeping them
 * separate from controllers and services means you can see every
 * endpoint at a glance without scrolling through handler functions.
 */

import { Router } from 'express';
import { signup, login, refreshTokens, logout } from '../controllers/authController.js';
import protect from '../middleware/protect.js';
import { authLimiter, signupLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Public routes (no token needed, but rate-limited)
router.post('/signup', signupLimiter, signup);
router.post('/login', authLimiter, login);
router.post('/refresh', refreshTokens);

// Protected route (requires valid access token)
router.post('/logout', protect, logout);

export default router;
