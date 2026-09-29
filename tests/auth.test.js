/**
 * Auth integration tests — tests the full HTTP flow for signup,
 * login, protected routes, token refresh, and logout.
 *
 * WHAT THIS TESTS:
 * 1. Signup creates a tenant + admin user, returns tokens
 * 2. Signup with a duplicate company slug fails with 409
 * 3. Login with correct credentials succeeds
 * 4. Login with wrong password fails with 401
 * 5. Protected route without a token fails with 401
 * 6. Protected route with an expired/invalid token fails with 401
 * 7. Refresh token flow issues a valid new access token
 * 8. Refresh with an old/reused (rotated-out) token fails
 *
 * HOW IT WORKS:
 * Uses mongodb-memory-server so we don't need a real database.
 * Supertest sends HTTP requests directly to the Express app
 * (no real server needed). Each test starts with a clean DB.
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

// ─── Helpers ───────────────────────────────────────────────

const validSignup = {
  companyName: 'Acme Corp',
  adminName: 'Alice Admin',
  email: 'alice@acme.com',
  password: 'SecureP@ss123',
};

async function signupAndGetTokens(overrides = {}) {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ ...validSignup, ...overrides });
  return res;
}

// ─── Tests ─────────────────────────────────────────────────

describe('POST /api/auth/signup', () => {
  it('creates a tenant + admin user and returns tokens', async () => {
    const res = await signupAndGetTokens();

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');

    // Tokens are present
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();

    // Tenant info
    expect(res.body.data.tenant.name).toBe('Acme Corp');
    expect(res.body.data.tenant.slug).toBe('acme-corp');

    // User info
    expect(res.body.data.user.name).toBe('Alice Admin');
    expect(res.body.data.user.email).toBe('alice@acme.com');

    // Access token payload has the right shape (no password!)
    const decoded = jwt.verify(
      res.body.data.accessToken,
      env.jwt.accessSecret,
    );
    expect(decoded.userId).toBeDefined();
    expect(decoded.tenantId).toBeDefined();
    expect(decoded.roleId).toBeDefined();
    expect(decoded.passwordHash).toBeUndefined();
  });

  it('fails with 409 when the company slug already exists', async () => {
    // First signup succeeds
    await signupAndGetTokens();

    // Second signup with same company name → duplicate slug
    const res = await signupAndGetTokens();

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/slug.*already exists/i);
  });

  it('fails with 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ companyName: 'Foo' }); // missing adminName, email, password

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    // Create a user to log in with
    await signupAndGetTokens();
  });

  it('succeeds with correct credentials (tenantSlug + email + password)', async () => {
    const res = await request(app).post('/api/auth/login').send({
      tenantSlug: 'acme-corp',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
  });

  it('fails with 401 when the password is wrong', async () => {
    const res = await request(app).post('/api/auth/login').send({
      tenantSlug: 'acme-corp',
      email: 'alice@acme.com',
      password: 'WrongPassword',
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('fails with 401 when the tenant slug is wrong', async () => {
    const res = await request(app).post('/api/auth/login').send({
      tenantSlug: 'nonexistent-company',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('fails with 400 when required fields are missing', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'alice@acme.com',
      // missing tenantSlug and password
    });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/me (protected route)', () => {
  it('fails with 401 when no token is provided', async () => {
    const res = await request(app).get('/api/me');

    expect(res.status).toBe(401);
  });

  it('fails with 401 when an invalid token is provided', async () => {
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', 'Bearer this.is.not.a.valid.token');

    expect(res.status).toBe(401);
  });

  it('fails with 401 when an expired token is provided', async () => {
    // Sign a token that expired 1 hour ago
    const expiredToken = jwt.sign(
      { userId: 'fake', tenantId: 'fake', roleId: 'fake' },
      env.jwt.accessSecret,
      { expiresIn: '-1h' },
    );

    const res = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/expired/i);
  });

  it('succeeds with a valid access token', async () => {
    // Signup to get a token
    const signup = await signupAndGetTokens();
    const token = signup.body.data.accessToken;

    const res = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBeDefined();
    expect(res.body.data.tenantId).toBeDefined();
    expect(res.body.data.permissions).toBeInstanceOf(Array);
    expect(res.body.data.permissions.length).toBeGreaterThan(0);
  });
});

describe('POST /api/auth/refresh', () => {
  it('issues a valid new access token (and a new refresh token)', async () => {
    // 1. Sign up to get initial tokens
    const signup = await signupAndGetTokens();
    const oldRefreshToken = signup.body.data.refreshToken;

    // 2. Use the refresh token to get new tokens
    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: oldRefreshToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();

    // The new tokens should be different from the old ones
    expect(res.body.data.refreshToken).not.toBe(oldRefreshToken);

    // 3. The new access token should work on a protected route
    const meRes = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);

    expect(meRes.status).toBe(200);
  });

  it('fails with 401 when using an old (rotated-out) refresh token', async () => {
    // 1. Sign up
    const signup = await signupAndGetTokens();
    const firstRefreshToken = signup.body.data.refreshToken;

    // 2. Refresh once — this rotates the token (bumps tokenVersion)
    const refresh1 = await request(app).post('/api/auth/refresh').send({
      refreshToken: firstRefreshToken,
    });
    expect(refresh1.status).toBe(200);

    // 3. Try to use the OLD (rotated-out) refresh token again
    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: firstRefreshToken,
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/revoked/i);
  });

  it('fails with 401 when the refresh token is garbage', async () => {
    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: 'not.a.real.token',
    });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('invalidates the refresh token', async () => {
    // 1. Sign up
    const signup = await signupAndGetTokens();
    const { accessToken, refreshToken } = signup.body.data;

    // 2. Logout (requires access token)
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(logoutRes.status).toBe(200);

    // 3. The old refresh token should no longer work
    const refreshRes = await request(app).post('/api/auth/refresh').send({
      refreshToken,
    });

    expect(refreshRes.status).toBe(401);
  });
});
