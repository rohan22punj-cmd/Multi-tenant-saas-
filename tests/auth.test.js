/**
 * Auth integration tests — tests the full HTTP flow for signup,
 * login, protected routes, token refresh (with rotation + reuse
 * detection), and logout.
 *
 * WHAT THIS TESTS:
 * 1. Signup creates a tenant + admin user, returns tokens
 * 2. Signup with a duplicate company slug fails with 409
 * 3. Login with correct credentials succeeds
 * 4. Login with wrong password fails with 401
 * 5. Protected route without a token fails with 401
 * 6. Protected route with an expired/invalid token fails with 401
 * 7. Refresh with a valid token returns new access + refresh tokens
 * 8. New access token has correct userId/tenantId/permissions
 * 9. Using the OLD refresh token after rotation returns 401
 * 10. After that reuse, even the NEWEST token stops working (safety wipe)
 * 11. Refresh with a garbage token returns 401
 * 12. Refresh for a deactivated user returns 401
 * 13. Logout makes the refresh token unusable
 * 14. Logout with a garbage token still returns 200
 * 15. Refresh token can't be used as access token, and vice versa
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

  it('succeeds with correct credentials (companySlug + email + password)', async () => {
    const res = await request(app).post('/api/auth/login').send({
      companySlug: 'acme-corp',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.id).toBeDefined();
    expect(res.body.data.user.name).toBe('Alice Admin');
    expect(res.body.data.user.email).toBe('alice@acme.com');
    expect(res.body.data.user.role).toBe('admin');

    // Access token payload has userId, tenantId, and permissions
    const decoded = jwt.verify(
      res.body.data.accessToken,
      env.jwt.accessSecret,
    );
    expect(decoded.userId).toBeDefined();
    expect(decoded.tenantId).toBeDefined();
    expect(decoded.permissions).toBeInstanceOf(Array);
    expect(decoded.permissions.length).toBeGreaterThan(0);
    expect(decoded.passwordHash).toBeUndefined();
  });

  it('fails with 401 when the password is wrong', async () => {
    const res = await request(app).post('/api/auth/login').send({
      companySlug: 'acme-corp',
      email: 'alice@acme.com',
      password: 'WrongPassword',
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('fails with 401 with the SAME message when the email is wrong', async () => {
    const res = await request(app).post('/api/auth/login').send({
      companySlug: 'acme-corp',
      email: 'nonexistent@acme.com',
      password: 'SecureP@ss123',
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('fails with 401 with the SAME message when the companySlug is wrong', async () => {
    const res = await request(app).post('/api/auth/login').send({
      companySlug: 'nonexistent-company',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('fails with 400 when required fields are missing', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'alice@acme.com',
      // missing companySlug and password
    });

    expect(res.status).toBe(400);
  });

  it('allows same email in different companies to log in to their own tenant', async () => {
    // Create a second tenant with the same email
    await request(app)
      .post('/api/auth/signup')
      .send({
        companyName: 'Beta Inc',
        adminName: 'Bob Admin',
        email: 'alice@acme.com', // SAME email
        password: 'SecureP@ss123',
      });

    // Login to first company
    const res1 = await request(app).post('/api/auth/login').send({
      companySlug: 'acme-corp',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });

    // Login to second company
    const res2 = await request(app).post('/api/auth/login').send({
      companySlug: 'beta-inc',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Each token should have its own tenantId
    const decoded1 = jwt.verify(res1.body.data.accessToken, env.jwt.accessSecret);
    const decoded2 = jwt.verify(res2.body.data.accessToken, env.jwt.accessSecret);

    expect(decoded1.tenantId).not.toBe(decoded2.tenantId);
    expect(decoded1.userId).not.toBe(decoded2.userId);
  });

  it('rejects login for a deactivated user', async () => {
    // First, deactivate the user
    const User = (await import('../src/models/User.js')).default;
    const user = await User.findOne({ email: 'alice@acme.com' });
    user.isActive = false;
    await user.save();

    const res = await request(app).post('/api/auth/login').send({
      companySlug: 'acme-corp',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
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
    expect(res.body.message).toBe('Unauthorized');
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
  it('returns 200 with new access and refresh tokens', async () => {
    const signup = await signupAndGetTokens();
    const oldRefreshToken = signup.body.data.refreshToken;

    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: oldRefreshToken,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.refreshToken).not.toBe(oldRefreshToken);
  });

  it('new access token has the right userId, tenantId, and permissions', async () => {
    const signup = await signupAndGetTokens();
    const oldRefreshToken = signup.body.data.refreshToken;

    // Decode the original access token for comparison
    const originalDecoded = jwt.verify(
      signup.body.data.accessToken,
      env.jwt.accessSecret,
    );

    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: oldRefreshToken,
    });

    const newDecoded = jwt.verify(
      res.body.data.accessToken,
      env.jwt.accessSecret,
    );

    expect(newDecoded.userId).toBe(originalDecoded.userId);
    expect(newDecoded.tenantId).toBe(originalDecoded.tenantId);
    expect(newDecoded.permissions).toEqual(originalDecoded.permissions);
  });

  it('rejects the OLD refresh token after rotation (returns 401)', async () => {
    const signup = await signupAndGetTokens();
    const firstRefreshToken = signup.body.data.refreshToken;

    // Refresh once — rotates the token
    const refresh1 = await request(app).post('/api/auth/refresh').send({
      refreshToken: firstRefreshToken,
    });
    expect(refresh1.status).toBe(200);

    // Try the OLD token again
    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: firstRefreshToken,
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });

  it('after reuse of old token, even the NEWEST refresh token stops working (safety wipe)', async () => {
    const signup = await signupAndGetTokens();
    const firstRefreshToken = signup.body.data.refreshToken;

    // Refresh to get the second token
    const refresh1 = await request(app).post('/api/auth/refresh').send({
      refreshToken: firstRefreshToken,
    });
    expect(refresh1.status).toBe(200);
    const secondRefreshToken = refresh1.body.data.refreshToken;

    // Reuse the OLD token (triggers the safety wipe)
    const reuse = await request(app).post('/api/auth/refresh').send({
      refreshToken: firstRefreshToken,
    });
    expect(reuse.status).toBe(401);

    // Now even the NEWEST token should be dead
    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: secondRefreshToken,
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });

  it('rejects a garbage token with 401', async () => {
    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: 'not.a.real.token',
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });

  it('rejects refresh for a deactivated user with 401', async () => {
    const signup = await signupAndGetTokens();

    // Deactivate the user
    const User = (await import('../src/models/User.js')).default;
    const user = await User.findOne({ email: 'alice@acme.com' });
    user.isActive = false;
    await user.save();

    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: signup.body.data.refreshToken,
    });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });

  it('a refresh token cannot be used as an access token', async () => {
    const signup = await signupAndGetTokens();
    const refreshToken = signup.body.data.refreshToken;

    // Try using the refresh token as a Bearer token on a protected route
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${refreshToken}`);

    // Should fail — refresh token is signed with a different secret
    expect(res.status).toBe(401);
  });

  it('an access token cannot be used as a refresh token', async () => {
    const signup = await signupAndGetTokens();
    const accessToken = signup.body.data.accessToken;

    // Try using the access token as a refresh token
    const res = await request(app).post('/api/auth/refresh').send({
      refreshToken: accessToken,
    });

    // Should fail — access token is signed with a different secret
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('makes the refresh token unusable afterwards', async () => {
    const signup = await signupAndGetTokens();
    const { refreshToken } = signup.body.data;

    // Logout
    const logoutRes = await request(app).post('/api/auth/logout').send({
      refreshToken,
    });

    expect(logoutRes.status).toBe(200);

    // The refresh token should no longer work
    const refreshRes = await request(app).post('/api/auth/refresh').send({
      refreshToken,
    });

    expect(refreshRes.status).toBe(401);
  });

  it('returns 200 even with a garbage token', async () => {
    const res = await request(app).post('/api/auth/logout').send({
      refreshToken: 'total.garbage.token',
    });

    expect(res.status).toBe(200);
  });

  it('returns 200 even with no token at all', async () => {
    const res = await request(app).post('/api/auth/logout').send({});

    expect(res.status).toBe(200);
  });
});
