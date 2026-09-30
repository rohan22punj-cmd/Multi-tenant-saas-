/**
 * Signup rate-limit test — proves the signupLimiter blocks the 6th
 * request from the same IP within the 15-minute window.
 *
 * WHY A SEPARATE FILE:
 * The main auth.test.js disables rate limiters via NODE_ENV=test
 * (the authLimiter and generalLimiter use `skip: () => isTest`).
 * The signupLimiter intentionally does NOT skip in test mode so we
 * can verify the 429 here. Keeping these tests in their own file
 * avoids tangling the two concerns.
 *
 * HOW IT WORKS:
 * Sends 6 signup requests. Each uses a unique email so the
 * duplicate-slug 409 doesn't fire before the rate limit kicks in.
 * Requests 1-5 should return 201 (or 409 — irrelevant, just
 * "not 429"). Request 6 must return 429.
 */

import request from 'supertest';
import app from '../src/app.js';
import { connectTestDB, clearTestDB, closeTestDB } from './setup.js';

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
      const res = await request(app)
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
    const blocked = await request(app)
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
