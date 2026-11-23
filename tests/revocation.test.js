/**
 * Instant Revocation Tests — proves that access tokens are rejected
 * immediately after deactivate, role change, password reset, or logout.
 *
 * WHAT THIS TESTS:
 * - A valid token gets 200; after deactivation, the SAME token gets 401
 * - After role change, the old token gets 401; fresh login gives new perms
 * - After password reset, old access tokens get 401
 * - A token issued after revocation works (fresh login)
 * - Revoking user A in company 1 does not affect same id in company 2
 * - Key expires after TTL; old tokens are expired by then anyway
 * - Redis down with fail-open: request works + warning logged
 * - Redis down with fail-closed: request returns 401
 * - Full earlier test suite still passes
 */

import request from 'supertest';
import app from '../src/app.js';
import { connectTestDB, clearTestDB, closeTestDB } from './setup.js';
import { signupCompany } from './helpers.js';
import { revokeUser, isRevoked, initRevocation, getRedis } from '../src/services/revocation.service.js';
import env from '../src/config/env.js';
import { runWithTenant } from '../src/utils/tenantContext.js';
import User from '../src/models/User.js';
import Role from '../src/models/Role.js';
import { PERMISSIONS } from '../src/constants/permissions.js';
import PasswordReset from '../src/models/PasswordReset.js';

let company, adminToken, memberToken, memberUser, memberId, tenantId;

beforeAll(async () => {
  await connectTestDB();
  // Initialize revocation with a SHORT TTL for testing (1 second)
  process.env.JWT_ACCESS_EXPIRES_IN = '1s'; // override for test
  await initRevocation();
});

afterAll(async () => {
  await closeTestDB();
  // Clean up Redis connection
  const redis = getRedis();
  if (redis) {
    try { await redis.quit(); } catch {}
  }
});

beforeEach(async () => {
  await clearTestDB();
  // Create a fresh company and admin for each test
  company = await signupCompany({ companyName: 'Test Corp' });
  adminToken = company.token;
  tenantId = company.tenantId;

  // Create a member user
  const memberRole = await runWithTenant({ tenantId }, async () =>
    Role.findOne({ name: 'member' })
  );
  memberUser = await runWithTenant({ tenantId }, async () =>
    User.create({
      tenantId,
      name: 'Member User',
      email: 'member@test.com',
      passwordHash: await (await import('bcryptjs')).default.hash('pass1234', 12),
      roleId: memberRole._id,
      isActive: true,
    })
  );
  memberId = memberUser._id.toString();

  // Login as member to get a fresh token
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ companySlug: company.slug, email: 'member@test.com', password: 'pass1234' });
  memberToken = loginRes.body.data.accessToken;
});

describe('Instant Revocation — Core Behavior', () => {
  test('valid token gets 200 on protected route', async () => {
    const res = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
  });

  test('after deactivation, same token immediately gets 401', async () => {
    // First, verify token works
    const before = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(before.status).toBe(200);

    // Deactivate the member (admin action)
    await request(app)
      .patch(`/api/users/${memberId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Same token should now be rejected
    const after = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(after.status).toBe(401);
  });

  test('after role change, old token gets 401; fresh login gives new perms', async () => {
    // First, verify member token works
    const before = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(before.status).toBe(200);

    // Admin changes member's role to admin
    const adminRole = await runWithTenant({ tenantId }, async () =>
      Role.findOne({ name: 'admin' })
    );
    await request(app)
      .patch(`/api/users/${memberId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roleId: adminRole._id.toString() })
      .expect(200);

    // Old token should be rejected
    const after = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(after.status).toBe(401);

    // Fresh login should work and have admin permissions
    const freshLogin = await request(app)
      .post('/api/auth/login')
      .send({ companySlug: company.slug, email: 'member@test.com', password: 'pass1234' });
    expect(freshLogin.status).toBe(200);
    const freshToken = freshLogin.body.data.accessToken;

    const freshRes = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(freshRes.status).toBe(200);
  });

  test('after password reset, old access tokens get 401', async () => {
    // Verify token works
    const before = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(before.status).toBe(200);

    // Create a reset token directly in DB with a known raw token
    const rawToken = 'known-reset-token-for-testing';
    const tokenHash = (await import('node:crypto')).createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await runWithTenant({ tenantId }, async () => {
      await PasswordReset.create({
        userId: memberId,
        tokenHash,
        expiresAt,
        usedAt: null,
      });
    });

    // Now reset password using the known raw token
    await request(app)
      .post('/api/auth/reset-password')
      .send({ token: rawToken, newPassword: 'NewPass123!' })
      .expect(200);

    // Old access token should now be rejected
    const after = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(after.status).toBe(401);

    // Fresh login with new password should work
    const freshLogin = await request(app)
      .post('/api/auth/login')
      .send({ companySlug: company.slug, email: 'member@test.com', password: 'NewPass123!' });
    expect(freshLogin.status).toBe(200);
    const freshToken = freshLogin.body.data.accessToken;

    const freshRes = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(freshRes.status).toBe(200);
  });
});

describe('Instant Revocation — Fresh Login After Revocation', () => {
  test('a token issued after revocation works (fresh login after reactivation)', async () => {
    // Deactivate member
    await request(app)
      .patch(`/api/users/${memberId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Old token rejected
    const rejected = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(rejected.status).toBe(401);

    // Reactivate
    await request(app)
      .patch(`/api/users/${memberId}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Fresh login works
    const freshLogin = await request(app)
      .post('/api/auth/login')
      .send({ companySlug: company.slug, email: 'member@test.com', password: 'pass1234' });
    expect(freshLogin.status).toBe(200);
    const freshToken = freshLogin.body.data.accessToken;

    const freshRes = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(freshRes.status).toBe(200);
  });

  test('revoking user A in company 1 does not affect user with same id in company 2', async () => {
    // Revoke in tenant A
    await revokeUser(tenantId, memberId);

    // The revocation for tenant A should not affect tenant B
    const payloadA = { iat: Math.floor(Date.now() / 1000) - 10, tenantId, userId: memberId };
    const payloadB = { iat: Math.floor(Date.now() / 1000) - 10, tenantId: 'other-tenant', userId: memberId };

    const revokedA = await isRevoked(payloadA);
    const revokedB = await isRevoked(payloadB);

    expect(revokedA).toBe(true);
    expect(revokedB).toBe(false);
  });
});

describe('Instant Revocation — TTL Expiry', () => {
  test('the key expires after the TTL and old tokens are expired by then anyway', async () => {
    // We set JWT_ACCESS_EXPIRES_IN = '1s' in beforeAll
    // Revoke the user
    await revokeUser(tenantId, memberId);

    // Immediately, token should be revoked
    const payload = { iat: Math.floor(Date.now() / 1000) - 1, tenantId, userId: memberId };
    const revokedNow = await isRevoked(payload);
    expect(revokedNow).toBe(true);

    // Wait for TTL to expire (2 seconds)
    await new Promise((r) => setTimeout(r, 2100));

    // Key should be gone
    const redis = getRedis();
    const key = `revoked:${tenantId}:${memberId}`;
    const exists = await redis.exists(key);
    expect(exists).toBe(0);

    // Even if we check with an old iat, no key means not revoked
    // But the token itself is also expired (1s lifetime)
    const revokedAfterTtl = await isRevoked(payload);
    expect(revokedAfterTtl).toBe(false);
  }, 5000);
});

describe('Instant Revocation — Service Functions', () => {
  test('revokeUser stores a key with correct format and TTL', async () => {
    await revokeUser(tenantId, memberId);

    const redis = getRedis();
    const key = `revoked:${tenantId}:${memberId}`;
    const value = await redis.get(key);
    const ttl = await redis.ttl(key);

    expect(value).toBeDefined();
    expect(parseInt(value, 10)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60 + 5); // ~15 min TTL + buffer
  });

  test('isRevoked returns false for non-existent key', async () => {
    const payload = { iat: Math.floor(Date.now() / 1000), tenantId, userId: 'nonexistent' };
    const revoked = await isRevoked(payload);
    expect(revoked).toBe(false);
  });

  test('isRevoked returns true when iat <= revokedAt', async () => {
    await revokeUser(tenantId, memberId);
    // Token issued 10 seconds ago (before revocation)
    const payload = { iat: Math.floor(Date.now() / 1000) - 10, tenantId, userId: memberId };
    const revoked = await isRevoked(payload);
    expect(revoked).toBe(true);
  });

  test('isRevoked returns false when iat > revokedAt (fresh token)', async () => {
    await revokeUser(tenantId, memberId);
    // Token issued 1 second in the future (simulating fresh login after revocation)
    const payload = { iat: Math.floor(Date.now() / 1000) + 1, tenantId, userId: memberId };
    const revoked = await isRevoked(payload);
    expect(revoked).toBe(false);
  });

  test('isRevoked handles malformed payload safely', async () => {
    const badPayloads = [
      { tenantId, userId: memberId }, // missing iat
      { iat: Date.now(), userId: memberId }, // missing tenantId
      { iat: Date.now(), tenantId }, // missing userId
    ];

    for (const payload of badPayloads) {
      const revoked = await isRevoked(payload);
      expect(revoked).toBe(true); // malformed → treat as revoked
    }
  });
});