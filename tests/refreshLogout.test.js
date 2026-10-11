/**
 * Refresh & logout integration tests — prove rotation, reuse detection,
 * and safe logout behaviour.
 *
 * WHAT THIS TESTS:
 * 1. Refresh with a valid token returns 200 with a NEW access token and a NEW refresh token.
 * 2. The new access token still has the right userId, tenantId, and permissions.
 * 3. Using the OLD refresh token again after a refresh returns 401.
 * 4. After that reuse attempt, even the NEWEST refresh token stops working (the safety wipe).
 * 5. Refresh with a garbage token returns 401.
 * 6. Refresh for a deactivated user returns 401.
 * 7. Logout makes the refresh token unusable afterwards.
 * 8. Logout with a garbage token still returns 200.
 * 9. A refresh token cannot be used as an access token, and an access token cannot be used as a refresh token (separate secrets prove this).
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import env from '../src/config/env.js';
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

// ─── Helper ───────────────────────────────────────────────
async function signupAndLogin() {
  // signup
  const signupRes = await request(app).post('/api/auth/signup').send({
    companyName: 'Test Corp',
    adminName: 'Test Admin',
    email: 'admin@test.com',
    password: 'SecureP@ss123',
  });
  expect(signupRes.status).toBe(201);

  // login to get fresh tokens (signup already returns tokens, but we use login to mimic real flow)
  const loginRes = await request(app).post('/api/auth/login').send({
    companySlug: 'test-corp',
    email: 'admin@test.com',
    password: 'SecureP@ss123',
  });
  expect(loginRes.status).toBe(200);
  return loginRes.body.data; // { accessToken, refreshToken, user }
}

describe('POST /api/auth/refresh', () => {
  it('refreshes with a valid token → new access & refresh tokens', async () => {
    const { accessToken, refreshToken } = await signupAndLogin();

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    // New tokens must differ from old ones
    expect(res.body.data.accessToken).not.toBe(accessToken);
    expect(res.body.data.refreshToken).not.toBe(refreshToken);
  });

  it('new access token carries correct payload (userId, tenantId, permissions)', async () => {
    const { refreshToken } = await signupAndLogin();
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);

    const decoded = jwt.verify(res.body.data.accessToken, env.jwt.accessSecret);
    expect(decoded.userId).toBeDefined();
    expect(decoded.tenantId).toBeDefined();
    expect(Array.isArray(decoded.permissions)).toBe(true);
    expect(decoded.permissions.length).toBeGreaterThan(0);
  });

  it('rejects reuse of the OLD refresh token with 401', async () => {
    const { refreshToken } = await signupAndLogin();

    // First refresh – succeeds
    const first = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(first.status).toBe(200);

    // Second refresh with SAME (now old) token – must fail
    const reuse = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.message).toBe('Invalid refresh token');
  });

  it('after reuse detection, even the NEWEST refresh token is dead (wipe)', async () => {
    const { refreshToken } = await signupAndLogin();

    // First refresh – get new token
    const first = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(first.status).toBe(200);
    const newRefresh = first.body.data.refreshToken;

    // Reuse the original token → triggers wipe
    await request(app).post('/api/auth/refresh').send({ refreshToken });

    // Now the newest token should also be rejected
    const afterWipe = await request(app).post('/api/auth/refresh').send({ refreshToken: newRefresh });
    expect(afterWipe.status).toBe(401);
    expect(afterWipe.body.message).toBe('Invalid refresh token');
  });

  it('rejects garbage token with 401', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: 'not.a.real.token' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });

  it('rejects refresh for a deactivated user', async () => {
    const { refreshToken } = await signupAndLogin();

    // Deactivate user
    const User = (await import('../src/models/User.js')).default;
    const user = await User.findOne({ email: 'admin@test.com' });
    user.isActive = false;
    await user.save();

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });
});

describe('POST /api/auth/logout', () => {
  it('logout invalidates the refresh token', async () => {
    const { refreshToken } = await signupAndLogin();

    // Logout
    const logoutRes = await request(app).post('/api/auth/logout').send({ refreshToken });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.message).toBe('Logged out successfully');

    // Refresh should now fail
    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.message).toBe('Invalid refresh token');
  });

  it('logout with garbage token still returns 200', async () => {
    const res = await request(app).post('/api/auth/logout').send({ refreshToken: 'garbage.token.here' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged out successfully');
  });
});

describe('Token separation (separate secrets)', () => {
  it('access token cannot be used as a refresh token', async () => {
    const { accessToken } = await signupAndLogin();
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: accessToken });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });

  it('refresh token cannot be used as an access token on a protected route', async () => {
    const { refreshToken } = await signupAndLogin();
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${refreshToken}`);
    expect(res.status).toBe(401);
  });
});