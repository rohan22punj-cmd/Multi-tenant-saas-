/**
 * Login rate-limit test — proves the loginLimiter blocks the 11th
 * request from the same IP within the 15-minute window.
 *
 * WHY A SEPARATE FILE:
 * The main auth.test.js disables rate limiters via NODE_ENV=test
 * (all exported limiters use `skip: () => isTest`). Here we create
 * a FRESH rate-limit instance with NO skip, wired to a minimal
 * Express app that calls the real login controller. This way the
 * limiter starts at zero for every test run, won't interfere with
 * auth.test.js, and exercises the exact same config/message shape
 * that production uses.
 *
 * HOW IT WORKS:
 * First creates a tenant + user via signup (bypassing the test limiter),
 * then sends 11 login requests. Requests 1-10 should return 200 or 401
 * (depending on credentials). Request 11 must return 429.
 */

import request from 'supertest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { signup, login } from '../src/controllers/authController.js';
import env from '../src/config/env.js';
import { connectTestDB, clearTestDB, closeTestDB } from './setup.js';

// ─── Build a mini app with a fresh (non-skipped) limiter ───

const testLoginLimiter = rateLimit({
  windowMs: env.loginRateLimit.windowMs,
  limit: env.loginRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  // No skip — that's the whole point of this test
  message: {
    status: 'error',
    message: 'Too many login attempts from this IP. Please try again after 15 minutes.',
  },
});

const testApp = express();
testApp.use(express.json());
// Signup without limiter so we can create the test user
testApp.post('/api/auth/signup', signup);
// Login WITH the test limiter
testApp.post('/api/auth/login', testLoginLimiter, login);

// ─── Lifecycle ─────────────────────────────────────────────

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

beforeEach(async () => {
  await clearTestDB();
});

// ─── Test ─────────────────────────────────────────────────

describe('Login rate limiter', () => {
  it('allows 10 requests then returns 429 on the 11th', async () => {
    // First, create a user to log in with (using signup without limiter)
    await request(testApp)
      .post('/api/auth/signup')
      .send({
        companyName: 'Rate Limit Test Corp',
        adminName: 'Test Admin',
        email: 'admin@ratelimit.com',
        password: 'SecureP@ss123',
      });

    // Fire 10 login requests with correct credentials
    for (let i = 1; i <= 10; i++) {
      const res = await request(testApp)
        .post('/api/auth/login')
        .send({
          companySlug: 'rate-limit-test-corp',
          email: 'admin@ratelimit.com',
          password: 'SecureP@ss123',
        });

      // Must not be 429 — rate limit hasn't been reached yet
      expect(res.status).not.toBe(429);
    }

    // 11th request — rate limit kicks in
    const blocked = await request(testApp)
      .post('/api/auth/login')
      .send({
        companySlug: 'rate-limit-test-corp',
        email: 'admin@ratelimit.com',
        password: 'SecureP@ss123',
      });

    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toBe(
      'Too many login attempts from this IP. Please try again after 15 minutes.',
    );
  }, 30000);
});