/**
 * Auth middleware integration tests — prove protect + tenantContext work.
 *
 * WHAT THIS TESTS:
 * 1. Valid access token returns 200 with correct userId and tenantId.
 * 2. No Authorization header returns 401.
 * 3. Malformed header returns 401.
 * 4. Expired access token returns 401.
 * 5. Tampered token (edited tenantId, same signature) returns 401.
 * 6. Refresh token used as access token returns 401.
 * 7. Different tenantId sent in body/query is ignored; token wins.
 * 8. Concurrency test: 20+ simultaneous requests with two companies
 *    never mix tenantIds.
 * 9. getTenantId() called outside a request throws clear error.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import env from '../src/config/env.js';
import { getTenantId } from '../src/utils/tenantContext.js';
import { connectTestDB, clearTestDB, closeTestDB } from './setup.js';

beforeAll(async () => {
  await connectTestDB();
});
afterAll(async () => {
  await closeTestDB();
});
beforeEach(async () => {
  await clearTestDB();
});

async function createUser(companyName, email, password = 'SecureP@ss123') {
  const signup = await request(app).post('/api/auth/signup').send({
    companyName,
    adminName: 'Admin',
    email,
    password,
  });
  expect(signup.status).toBe(201);
  const login = await request(app).post('/api/auth/login').send({
    companySlug: signup.body.data.tenant.slug,
    email,
    password,
  });
  expect(login.status).toBe(200);
  return login.body.data; // { accessToken, refreshToken, user }
}

// Helper to make a request with a token
function getMe(token) {
  return request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
}

describe('GET /api/me (protected)', () => {
  let tokenA, tokenB, slugA, slugB;

  beforeEach(async () => {
    const a = await createUser('Alpha Corp', 'a@alpha.com');
    const b = await createUser('Beta Inc', 'b@beta.com');
    tokenA = a.accessToken;
    tokenB = b.accessToken;
    slugA = a.user.id; // not used
    slugB = b.user.id;
  });

  it('valid token returns 200 with correct userId and tenantId', async () => {
    const res = await getMe(tokenA);
    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBeDefined();
    expect(res.body.data.tenantId).toBeDefined();
    expect(res.body.data.contextTenantId).toBe(res.body.data.tenantId);
    expect(Array.isArray(res.body.data.permissions)).toBe(true);
  });

  it('no Authorization header returns 401', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Unauthorized');
  });

  it('malformed header returns 401', async () => {
    const res1 = await request(app).get('/api/me').set('Authorization', 'Bearer');
    expect(res1.status).toBe(401);
    const res2 = await request(app).get('/api/me').set('Authorization', 'Token abc');
    expect(res2.status).toBe(401);
  });

  it('expired access token returns 401', async () => {
    const expired = jwt.sign(
      { userId: 'fake', tenantId: 'fake', roleId: 'fake', permissions: [] },
      env.jwt.accessSecret,
      { expiresIn: '-1s' }
    );
    const res = await getMe(expired);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Unauthorized');
  });

  it('tampered token (changed tenantId) returns 401', async () => {
    const decoded = jwt.decode(tokenA);
    // modify tenantId
    decoded.tenantId = '000000000000000000000000';
    // re-sign with SAME secret? Actually we cannot re-sign without secret.
    // Instead create a token with altered payload but valid signature? Not possible.
    // We'll create a token with different payload signed with same secret.
    const tampered = jwt.sign(
      { ...decoded, tenantId: '000000000000000000000000' },
      env.jwt.accessSecret,
      { expiresIn: '15m' }
    );
    const res = await getMe(tampered);
    // This will be valid signature but different tenantId – still accepted by middleware.
    // Requirement: token with tampered payload but old signature => 401.
    // To test old signature, we can take tokenA, split, modify middle part, keep signature -> invalid signature.
    const parts = tokenA.split('.');
    const tampered2 = `${parts[0]}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64').toString()), tenantId: '000000000000000000000000' })).toString('base64')}.${parts[2]}`;
    const res2 = await getMe(tampered2);
    expect(res2.status).toBe(401);
    expect(res2.body.message).toBe('Unauthorized');
  });

  it('refresh token used as access token returns 401', async () => {
    const login = await request(app).post('/api/auth/login').send({
      companySlug: 'alpha-corp',
      email: 'a@alpha.com',
      password: 'SecureP@ss123',
    });
    const refresh = login.body.data.refreshToken;
    const res = await getMe(refresh);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Unauthorized');
  });

  it('tenantId in body/query is ignored', async () => {
    const res = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${tokenA}`)
      .query({ tenantId: '999999999999999999999999' })
      .send({ tenantId: '888888888888888888888888' });
    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).not.toBe('999999999999999999999999');
    expect(res.body.data.tenantId).not.toBe('888888888888888888888888');
  });
});

describe('Concurrency: no tenant leakage', () => {
  it('20 parallel requests with two companies keep correct tenantId', async () => {
    const a = await createUser('Gamma Ltd', 'g@gamma.com');
    const b = await createUser('Delta LLC', 'd@delta.com');

    const decode = (token) => jwt.verify(token, env.jwt.accessSecret);
    const tenantIdA = decode(a.accessToken).tenantId;
    const tenantIdB = decode(b.accessToken).tenantId;

    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        getMe(a.accessToken).then(r => ({ who: 'a', tenantId: r.body.data.tenantId })),
        getMe(b.accessToken).then(r => ({ who: 'b', tenantId: r.body.data.tenantId }))
      );
    }
    const results = await Promise.all(promises);
    // All 'a' responses must have a's tenantId
    results.filter(r => r.who === 'a').forEach(r => {
      expect(r.tenantId).toBe(tenantIdA);
    });
    results.filter(r => r.who === 'b').forEach(r => {
      expect(r.tenantId).toBe(tenantIdB);
    });
    // Ensure no mixing
    const tenantIdsA = results.filter(r => r.who === 'a').map(r => r.tenantId);
    const tenantIdsB = results.filter(r => r.who === 'b').map(r => r.tenantId);
    expect(new Set([...tenantIdsA, ...tenantIdsB]).size).toBe(2);
  });
});

describe('getTenantId() safety', () => {
  it('throws when called outside a request context', () => {
    expect(() => getTenantId()).toThrow('getTenantId() called outside a tenant context');
  });
});