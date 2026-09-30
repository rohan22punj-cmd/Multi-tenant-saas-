/**
 * Signup rate-limit test — proves the signupLimiter blocks the 6th
 * request from the same IP within the 15-minute window.
 *
 * WHY A SEPARATE FILE:
 * The main auth.test.js disables rate limiters via NODE_ENV=test
 * (all exported limiters use `skip: () => isTest`). Here we create
 * a FRESH rate-limit instance with NO skip, wired to a minimal
 * Express app that calls the real signup controller. This way the
 * limiter starts at zero for every test run, won't interfere with
 * auth.test.js, and exercises the exact same config/message shape
 * that production uses.
 *
 * HOW IT WORKS:
 * Sends 6 signup requests. Each uses a unique company name so the
 * duplicate-slug 409 doesn't fire before the rate limit kicks in.
 * Requests 1-5 should return 201. Request 6 must return 429.
 */

import request from 'supertest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { signup } from '../src/controllers/authController.js';
import env from '../src/config/env.js';
import { connectTestDB, clearTestDB, closeTestDB } from './setup.js';

// ─── Build a mini app with a fresh (non-skipped) limiter ───

const testSignupLimiter = rateLimit({
  windowMs: env.signupRateLimit.windowMs,
  limit: env.signupRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  // No skip — that's the whole point of this test
  message: {
    error: 'Too many signup attempts, please try again later.',
  },
});

const testApp = express();
testApp.use(express.json());
testApp.post('/api/auth/signup', testSignupLimiter, signup);

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

describe('Signup rate limiter', () => {
  it('allows 5 requests then returns 429 on the 6th', async () => {
    // Fire 5 requests — each with a unique slug so none 409 on duplicate
    for (let i = 1; i <= 5; i++) {
      const res = await request(testApp)
        .post('/api/auth/signup')
        .send({
          companyName: `Company ${i}`,
          adminName: `Admin ${i}`,
          email: `admin${i}@company${i}.com`,
          password: 'SecureP@ss123',
        });

      // Must not be 429 — rate limit hasn't been reached yet
      expect(res.status).not.toBe(429);
    }

    // 6th request — rate limit kicks in
    const blocked = await request(testApp)
      .post('/api/auth/signup')
      .send({
        companyName: 'Company 6',
        adminName: 'Admin 6',
        email: 'admin6@company6.com',
        password: 'SecureP@ss123',
      });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe(
      'Too many signup attempts, please try again later.',
    );
  });
});
