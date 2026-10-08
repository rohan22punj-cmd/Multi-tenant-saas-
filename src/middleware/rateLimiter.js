/**
 * Rate limiters — throttle requests to prevent brute-force attacks.
 *
 * WHAT THIS DOES:
 * Uses express-rate-limit to cap how many requests one IP can make
 * to a given endpoint within a time window. Two presets:
 *
 * 1. authLimiter  — strict, for /api/auth/login and /api/auth/signup.
 *    15 attempts per 15-minute window. This makes brute-forcing a
 *    password impractical without completely locking out a user who
 *    mistyped their password a few times.
 *
 * 2. generalLimiter — more generous, for the rest of the API.
 *    100 requests per 15-minute window. Enough for normal app usage
 *    but catches runaway scripts or accidental infinite loops.
 *
 * IN TEST MODE: Rate limiting is skipped so the test suite can
 * send as many requests as it needs without hitting fake limits.
 * Rate limits protect against external abuse, not your own tests.
 * We use the `skip` option (not `max: 0`, which in v7+ blocks
 * ALL requests).
 *
 * WHY express-rate-limit AND NOT Redis-BACKED:
 * For Phase 2, in-memory rate limiting is fine since we run one
 * server instance. In production with multiple instances behind
 * a load balancer, we'd swap to a Redis store (rate-limit-redis)
 * so the counters are shared. The API is the same — only the
 * `store` option changes.
 *
 * WHY THE LIMIT IS PER IP:
 * We use the default keyGenerator (req.ip). For login brute-force,
 * IP-based limiting is the standard first line of defence. If we
 * later need per-account limiting (e.g. "lock account after 10
 * failures"), that goes in the authService, not here.
 */

import rateLimit from 'express-rate-limit';
import env from '../config/env.js';

const isTest = process.env.NODE_ENV === 'test';

/**
 * Strict limiter for auth endpoints (login, signup).
 * 15 requests per 15-minute window per IP.
 * Skipped entirely in test mode.
 */
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 15,
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false,
    skip: () => isTest, // disable in test mode
    message: {
        status: 'error',
        message: 'Too many requests from this IP. Please try again after 15 minutes.',
    },
});

/**
 * Login-specific rate limiter.
 * 10 requests per 15-minute window per IP.
 * Configurable via LOGIN_RATE_LIMIT_WINDOW_MS and LOGIN_RATE_LIMIT_MAX.
 * Skipped in test mode (tests verify the 429 directly in a separate file).
 */
export const loginLimiter = rateLimit({
    windowMs: env.loginRateLimit.windowMs,
    limit: env.loginRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest,
    message: {
        status: 'error',
        message: 'Too many login attempts from this IP. Please try again after 15 minutes.',
    },
});

/**
 * Strict limiter for signup only.
 * Configurable via SIGNUP_RATE_LIMIT_WINDOW_MS and SIGNUP_RATE_LIMIT_MAX.
 * Defaults to 5 requests per 15-minute window per IP.
 *
 * NOT skipped in test mode — tests verify the 429 directly.
 */
export const signupLimiter = rateLimit({
    windowMs: env.signupRateLimit.windowMs,
    limit: env.signupRateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest,
    message: {
        error: 'Too many signup attempts, please try again later.',
    },
});

/**
 * General limiter for all other API routes.
 * 100 requests per 15-minute window per IP.
 * Skipped entirely in test mode.
 */
export const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest,
    message: {
        status: 'error',
        message: 'Too many requests from this IP. Please slow down.',
    },
});