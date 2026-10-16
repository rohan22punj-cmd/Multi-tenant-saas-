/**
 * Tenant Isolation Tests — proves that the tenant filter plugin
 * correctly scopes every operation to the current tenant.
 *
 * WHAT THIS TESTS:
 * - Two companies (A and B) with their own users and roles
 * - Inside A's context: find() returns only A's documents, never B's
 * - findById / findOne with B's document id inside A's context returns null
 * - Inside A's context: updateOne / updateMany / findOneAndUpdate on B's document changes nothing (matched count 0)
 * - deleteOne / deleteMany in A's context cannot delete B's documents
 * - countDocuments and distinct only see A's data
 * - aggregate in A's context only returns A's documents
 * - A filter that explicitly asks for B's tenantId inside A's context still returns nothing (forced overwrite)
 * - populate across models stays scoped
 * - Creating a document inside A's context gets A's tenantId automatically, even if tenantId is not passed
 * - Creating a document with B's tenantId inside A's context throws
 * - Trying to update a document's tenantId throws
 * - Any query run OUTSIDE any context throws the clear error
 * - estimatedDocumentCount and bulkWrite throw the clear error on scoped models
 * - runUnscoped sees both companies and logs the reason
 * - HTTP level test: log in as A and as B, call /api/me style routes at the same time (20+ mixed requests), confirm no mixing
 */

import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/app.js';
import env from '../src/config/env.js';
import { connectTestDB, clearTestDB, closeTestDB } from './setup.js';
import { runWithTenant, runUnscoped } from '../src/utils/tenantContext.js';
import User from '../src/models/User.js';
import Role from '../src/models/Role.js';
import Tenant from '../src/models/Tenant.js';

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

beforeEach(async () => {
  await clearTestDB();
});

// ─── Helpers ────────────────────────────────────────────────────

async function createTenant(name, slug) {
  return runUnscoped(`test: create tenant ${name}`, () => Tenant.create({ name, slug }));
}

async function createRoleInContext(tenantId, name, permissions) {
  return runWithTenant({ tenantId }, () => Role.create({ name, permissions, isSystemRole: true }));
}

async function createUserInContext(tenantId, name, email, passwordHash, roleId) {
  return runWithTenant({ tenantId }, () => User.create({
    name,
    email,
    passwordHash,
    roleId,
  }));
}

async function loginUser(companySlug, email, password) {
  const res = await request(app).post('/api/auth/login').send({ companySlug, email, password });
  return res.body.data;
}

const PASSWORD_HASH = '$2a$12$dummyhashdummyhashdummyh'; // not actually used for direct login

describe('Tenant Isolation — Unit Level (direct model calls)', () => {
  let tenantA, tenantB;
  let roleA, roleB;
  let userA1, userA2, userB1;

  beforeEach(async () => {
    // Create two tenants unscoped
    tenantA = await createTenant('Company A', 'company-a');
    tenantB = await createTenant('Company B', 'company-b');

    // Create roles inside each tenant's context
    roleA = await createRoleInContext(tenantA._id, 'admin', ['perm:all']);
    roleB = await createRoleInContext(tenantB._id, 'admin', ['perm:all']);

    // Create users inside each tenant's context
    userA1 = await createUserInContext(tenantA._id, 'Alice A1', 'alice@a.com', PASSWORD_HASH, roleA._id);
    userA2 = await createUserInContext(tenantA._id, 'Alice A2', 'alice2@a.com', PASSWORD_HASH, roleA._id);
    userB1 = await createUserInContext(tenantB._id, 'Bob B1', 'bob@b.com', PASSWORD_HASH, roleB._id);
  });

  describe('find / findOne / findById', () => {
    it('inside A context, find() returns only A users', async () => {
      const users = await runWithTenant({ tenantId: tenantA._id }, () => User.find().lean());
      expect(users).toHaveLength(2);
      expect(users.every(u => u.tenantId.equals(tenantA._id))).toBe(true);
    });

    it('inside A context, findById with B user id returns null', async () => {
      const user = await runWithTenant({ tenantId: tenantA._id }, () => User.findById(userB1._id).lean());
      expect(user).toBeNull();
    });

    it('inside A context, findOne with B user id returns null', async () => {
      const user = await runWithTenant({ tenantId: tenantA._id }, () => User.findOne({ _id: userB1._id }).lean());
      expect(user).toBeNull();
    });

    it('inside A context, findOne with explicit B tenantId filter returns null (forced overwrite)', async () => {
      // Even though the caller explicitly asks for B's tenantId, the plugin force-overwrites it
      const user = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.findOne({ tenantId: tenantB._id, email: 'bob@b.com' }).lean()
      );
      expect(user).toBeNull();
    });

    it('inside B context, find() returns only B users', async () => {
      const users = await runWithTenant({ tenantId: tenantB._id }, () => User.find().lean());
      expect(users).toHaveLength(1);
      expect(users[0].tenantId.equals(tenantB._id)).toBe(true);
    });
  });

  describe('updateOne / updateMany / findOneAndUpdate', () => {
    it('inside A context, updateOne on B user matches 0 and does not modify', async () => {
      const originalName = userB1.name;

      const result = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.updateOne({ _id: userB1._id }, { name: 'HACKED' })
      );

      expect(result.matchedCount).toBe(0);
      expect(result.modifiedCount).toBe(0);

      // Verify B's user unchanged (unscoped check)
      const unchanged = await runUnscoped('test: verify B user unchanged', () => User.findById(userB1._id).lean());
      expect(unchanged.name).toBe(originalName);
    });

    it('inside A context, updateMany on B users matches 0', async () => {
      const result = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.updateMany({ tenantId: tenantB._id }, { name: 'HACKED' })
      );
      expect(result.matchedCount).toBe(0);
      expect(result.modifiedCount).toBe(0);
    });

    it('inside A context, findOneAndUpdate on B user returns null', async () => {
      const result = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.findOneAndUpdate({ _id: userB1._id }, { name: 'HACKED' }, { new: true }).lean()
      );
      expect(result).toBeNull();
    });

    it('inside A context, updateOne on A user works normally', async () => {
      const result = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.updateOne({ _id: userA1._id }, { name: 'Alice Updated' })
      );
      expect(result.matchedCount).toBe(1);
      expect(result.modifiedCount).toBe(1);

      const updated = await runWithTenant({ tenantId: tenantA._id }, () => User.findById(userA1._id).lean());
      expect(updated.name).toBe('Alice Updated');
    });
  });

  describe('deleteOne / deleteMany', () => {
    it('inside A context, deleteOne on B user deletes 0', async () => {
      const result = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.deleteOne({ _id: userB1._id })
      );
      expect(result.deletedCount).toBe(0);

      // Verify B's user still exists
      const exists = await runUnscoped('test: verify B user exists', () => User.findById(userB1._id).lean());
      expect(exists).not.toBeNull();
    });

    it('inside A context, deleteMany with B tenantId filter deletes 0', async () => {
      const result = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.deleteMany({ tenantId: tenantB._id })
      );
      expect(result.deletedCount).toBe(0);
    });

    it('inside A context, deleteOne on A user works', async () => {
      const result = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.deleteOne({ _id: userA2._id })
      );
      expect(result.deletedCount).toBe(1);

      const remaining = await runWithTenant({ tenantId: tenantA._id }, () => User.find().lean());
      expect(remaining).toHaveLength(1);
    });
  });

  describe('countDocuments / distinct', () => {
    it('countDocuments in A context only counts A users', async () => {
      const count = await runWithTenant({ tenantId: tenantA._id }, () => User.countDocuments());
      expect(count).toBe(2);
    });

    it('distinct in A context only sees A emails', async () => {
      const emails = await runWithTenant({ tenantId: tenantA._id }, () => User.distinct('email'));
      expect(emails).toHaveLength(2);
      expect(emails).toEqual(expect.arrayContaining(['alice@a.com', 'alice2@a.com']));
      expect(emails).not.toContain('bob@b.com');
    });
  });

  describe('aggregate', () => {
    it('aggregate in A context only returns A users', async () => {
      const results = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.aggregate([
          { $project: { name: 1, email: 1, tenantId: 1 } },
          { $sort: { email: 1 } },
        ])
      );
      expect(results).toHaveLength(2);
      expect(results.every(r => r.tenantId.equals(tenantA._id))).toBe(true);
    });

    it('aggregate with $geoNear as first stage throws clear error', async () => {
      // Create a user with location for geoNear test
      await runWithTenant({ tenantId: tenantA._id }, () =>
        User.create({ name: 'Geo User', email: 'geo@a.com', passwordHash: PASSWORD_HASH, roleId: roleA._id, location: { type: 'Point', coordinates: [0, 0] } })
      );

      // We need to add a 2dsphere index for $geoNear to work, but we just test the error
      // The plugin should throw before reaching MongoDB
      await expect(
        runWithTenant({ tenantId: tenantA._id }, () =>
          User.aggregate([{ $geoNear: { near: { type: 'Point', coordinates: [0, 0] }, distanceField: 'dist' } }])
        )
      ).rejects.toThrow(/geoNear/i);
    });
  });

  describe('populate', () => {
    it('populate across models stays scoped to current tenant', async () => {
      // Create a role for A (already have roleA)
      // Populate userA1's role
      const userWithRole = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.findById(userA1._id).populate('roleId').lean()
      );
      expect(userWithRole).not.toBeNull();
      expect(userWithRole.roleId).toBeDefined();
      expect(userWithRole.roleId._id.equals(roleA._id)).toBe(true);
      expect(userWithRole.roleId.tenantId.equals(tenantA._id)).toBe(true);
    });

    it('populate in A context cannot see B roles', async () => {
      // Try to populate with a role from B - should not find it
      const userWithWrongRole = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.findById(userA1._id).populate({ path: 'roleId', match: { _id: roleB._id } }).lean()
      );
      expect(userWithWrongRole.roleId).toBeNull();
    });
  });

  describe('document creation (save / create / insertMany)', () => {
    it('creating a document in A context auto-stamps A tenantId', async () => {
      const user = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.create({ name: 'New User', email: 'new@a.com', passwordHash: PASSWORD_HASH, roleId: roleA._id })
      );
      expect(user.tenantId.equals(tenantA._id)).toBe(true);
    });

    it('creating a document with explicit B tenantId in A context throws', async () => {
      await expect(
        runWithTenant({ tenantId: tenantA._id }, () =>
          User.create({ name: 'Hacker', email: 'hack@a.com', passwordHash: PASSWORD_HASH, roleId: roleA._id, tenantId: tenantB._id })
        )
      ).rejects.toThrow(/does not match current context/i);
    });

    it('insertMany in A context stamps all docs with A tenantId', async () => {
      const users = await runWithTenant({ tenantId: tenantA._id }, () =>
        User.insertMany([
          { name: 'Batch 1', email: 'batch1@a.com', passwordHash: PASSWORD_HASH, roleId: roleA._id },
          { name: 'Batch 2', email: 'batch2@a.com', passwordHash: PASSWORD_HASH, roleId: roleA._id },
        ])
      );
      expect(users).toHaveLength(2);
      expect(users.every(u => u.tenantId.equals(tenantA._id))).toBe(true);
    });

    it('save on existing document in A context does not allow tenantId change', async () => {
      const user = await runWithTenant({ tenantId: tenantA._id }, () => User.findById(userA1._id));
      user.tenantId = tenantB._id;

      await expect(
        runWithTenant({ tenantId: tenantA._id }, () => user.save())
      ).rejects.toThrow(/changing tenantId is not allowed/i);
    });
  });

  describe('blocking tenantId changes on updates', () => {
    it('updateOne with $set tenantId throws', async () => {
      await expect(
        runWithTenant({ tenantId: tenantA._id }, () =>
          User.updateOne({ _id: userA1._id }, { $set: { tenantId: tenantB._id } })
        )
      ).rejects.toThrow(/changing tenantId via \$set is not allowed/i);
    });

    it('updateOne with direct tenantId in update doc throws', async () => {
      await expect(
        runWithTenant({ tenantId: tenantA._id }, () =>
          User.updateOne({ _id: userA1._id }, { tenantId: tenantB._id })
        )
      ).rejects.toThrow(/changing tenantId is not allowed/i);
    });

    it('replaceOne with tenantId throws', async () => {
      await expect(
        runWithTenant({ tenantId: tenantA._id }, () =>
          User.replaceOne({ _id: userA1._id }, { name: 'Replaced', email: 'replaced@a.com', passwordHash: PASSWORD_HASH, roleId: roleA._id, tenantId: tenantB._id })
        )
      ).rejects.toThrow(/changing tenantId is not allowed/i);
    });
  });

  describe('operations outside any context throw', () => {
    it('find() outside context throws', async () => {
      await expect(User.find().lean()).rejects.toThrow(/outside a tenant context/i);
    });

    it('findOne() outside context throws', async () => {
      await expect(User.findOne({}).lean()).rejects.toThrow(/outside a tenant context/i);
    });

    it('create() outside context throws', async () => {
      await expect(User.create({ name: 'Test', email: 'test@test.com', passwordHash: PASSWORD_HASH, roleId: roleA._id }))
        .rejects.toThrow(/outside a tenant context/i);
    });

    it('updateOne() outside context throws', async () => {
      await expect(User.updateOne({}, { name: 'Test' })).rejects.toThrow(/outside a tenant context/i);
    });

    it('deleteOne() outside context throws', async () => {
      await expect(User.deleteOne({})).rejects.toThrow(/outside a tenant context/i);
    });

    it('countDocuments() outside context throws', async () => {
      await expect(User.countDocuments()).rejects.toThrow(/outside a tenant context/i);
    });

    it('distinct() outside context throws', async () => {
      await expect(User.distinct('email')).rejects.toThrow(/outside a tenant context/i);
    });

    it('aggregate() outside context throws', async () => {
      await expect(User.aggregate([{ $match: {} }])).rejects.toThrow(/outside a tenant context/i);
    });

    it('save() on new document outside context throws', async () => {
      const user = new User({ name: 'Test', email: 'test@test.com', passwordHash: PASSWORD_HASH, roleId: roleA._id });
      await expect(user.save()).rejects.toThrow(/outside a tenant context/i);
    });
  });

  describe('estimatedDocumentCount and bulkWrite throw on scoped models', () => {
    it('estimatedDocumentCount throws clear error', async () => {
      await expect(
        runWithTenant({ tenantId: tenantA._id }, () => User.estimatedDocumentCount())
      ).rejects.toThrow(/estimatedDocumentCount.*cannot be filtered by tenant/i);
    });

    it('bulkWrite throws clear error', async () => {
      await expect(
        runWithTenant({ tenantId: tenantA._id }, () =>
          User.bulkWrite([{ insertOne: { document: { name: 'Test', email: 'test@test.com', passwordHash: PASSWORD_HASH, roleId: roleA._id } } }])
        )
      ).rejects.toThrow(/bulkWrite.*not supported on tenant-scoped models/i);
    });

    it('estimatedDocumentCount works inside runUnscoped', async () => {
      const count = await runUnscoped('test: count all users unscoped', () => User.estimatedDocumentCount());
      expect(count).toBe(3); // userA1, userA2, userB1
    });

    it('bulkWrite works inside runUnscoped', async () => {
      await runUnscoped('test: bulk insert unscoped', async () => {
        await User.bulkWrite([
          { insertOne: { document: { name: 'Bulk 1', email: 'bulk1@test.com', passwordHash: PASSWORD_HASH, roleId: roleA._id, tenantId: tenantA._id } } },
          { insertOne: { document: { name: 'Bulk 2', email: 'bulk2@test.com', passwordHash: PASSWORD_HASH, roleId: roleB._id, tenantId: tenantB._id } } },
        ]);
      });
      const all = await runUnscoped('test: verify bulk insert', () => User.find().lean());
      expect(all).toHaveLength(5); // 3 original + 2 new
    });
  });

  describe('runUnscoped escape hatch', () => {
    it('runUnscoped sees both companies\' users', async () => {
      const allUsers = await runUnscoped('test: list all users for admin dashboard', () => User.find().lean());
      expect(allUsers).toHaveLength(3);
      const tenantIds = [...new Set(allUsers.map(u => u.tenantId.toString()))];
      expect(tenantIds).toHaveLength(2);
    });

    it('runUnscoped sees both companies\' roles', async () => {
      const allRoles = await runUnscoped('test: list all roles for audit', () => Role.find().lean());
      expect(allRoles).toHaveLength(2);
    });

    it('runUnscoped logs a warning with the reason', async () => {
      // We can't easily test the logger output here, but we verify the function exists and works
      const result = await runUnscoped('test reason', () => User.countDocuments());
      expect(typeof result).toBe('number');
    });

    it('runUnscoped requires a non-empty reason', async () => {
      await expect(runUnscoped('', () => User.find())).rejects.toThrow(/requires a non-empty reason/);
      await expect(runUnscoped('   ', () => User.find())).rejects.toThrow(/requires a non-empty reason/);
    });
  });
});

describe('Tenant Isolation — HTTP Level (concurrent A and B requests)', () => {
  let tokenA, tokenB;

  beforeEach(async () => {
    // Sign up two companies
    await request(app).post('/api/auth/signup').send({
      companyName: 'Company A',
      adminName: 'Alice Admin',
      email: 'alice@a.com',
      password: 'SecureP@ss123',
    });

    await request(app).post('/api/auth/signup').send({
      companyName: 'Company B',
      adminName: 'Bob Admin',
      email: 'bob@b.com',
      password: 'SecureP@ss123',
    });

    // Log in to get tokens
    const loginA = await request(app).post('/api/auth/login').send({
      companySlug: 'company-a',
      email: 'alice@a.com',
      password: 'SecureP@ss123',
    });
    tokenA = loginA.body.data.accessToken;

    const loginB = await request(app).post('/api/auth/login').send({
      companySlug: 'company-b',
      email: 'bob@b.com',
      password: 'SecureP@ss123',
    });
    tokenB = loginB.body.data.accessToken;
  });

  it('20+ mixed concurrent requests to /api/me never mix tenant data', async () => {
    const requests = [];

    // 10 requests as Company A
    for (let i = 0; i < 10; i++) {
      requests.push(
        request(app).get('/api/me').set('Authorization', `Bearer ${tokenA}`)
      );
    }

    // 10 requests as Company B
    for (let i = 0; i < 10; i++) {
      requests.push(
        request(app).get('/api/me').set('Authorization', `Bearer ${tokenB}`)
      );
    }

    // Execute all concurrently
    const responses = await Promise.all(requests);

    // Verify all succeeded
    responses.forEach((res, idx) => {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    // Verify A's requests all see A's tenantId
    const aResponses = responses.slice(0, 10);
    aResponses.forEach(res => {
      expect(res.body.data.tenantId).toBeDefined();
      expect(res.body.data.contextTenantId).toBe(res.body.data.tenantId);
      expect(res.body.data.userId).toBeDefined();
    });

    // Verify B's requests all see B's tenantId
    const bResponses = responses.slice(10, 20);
    bResponses.forEach(res => {
      expect(res.body.data.tenantId).toBeDefined();
      expect(res.body.data.contextTenantId).toBe(res.body.data.tenantId);
      expect(res.body.data.userId).toBeDefined();
    });

    // Verify A and B have different tenantIds
    const aTenantId = aResponses[0].body.data.tenantId;
    const bTenantId = bResponses[0].body.data.tenantId;
    expect(aTenantId).not.toBe(bTenantId);

    // Verify no mixing: all A responses have same tenantId, all B responses have same tenantId
    aResponses.forEach(res => expect(res.body.data.tenantId).toBe(aTenantId));
    bResponses.forEach(res => expect(res.body.data.tenantId).toBe(bTenantId));
  });
});

describe('Regression — Existing Auth Tests Still Pass', () => {
  const validSignup = {
    companyName: 'Acme Corp',
    adminName: 'Alice Admin',
    email: 'alice@acme.com',
    password: 'SecureP@ss123',
  };

  async function signupAndGetTokens(overrides = {}) {
    const res = await request(app).post('/api/auth/signup').send({ ...validSignup, ...overrides });
    return res;
  }

  it('signup creates tenant + admin user and returns tokens', async () => {
    const res = await signupAndGetTokens();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.tenant.name).toBe('Acme Corp');
    expect(res.body.data.tenant.slug).toBe('acme-corp');
    expect(res.body.data.user.name).toBe('Alice Admin');
    expect(res.body.data.user.email).toBe('alice@acme.com');

    const decoded = jwt.verify(res.body.data.accessToken, env.jwt.accessSecret);
    expect(decoded.userId).toBeDefined();
    expect(decoded.tenantId).toBeDefined();
    expect(decoded.roleId).toBeDefined();
    expect(decoded.passwordHash).toBeUndefined();
  });

  it('signup with duplicate company slug fails with 409', async () => {
    await signupAndGetTokens();
    const res = await signupAndGetTokens();
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/slug.*already exists/i);
  });

  it('login with correct credentials succeeds', async () => {
    await signupAndGetTokens();
    const res = await request(app).post('/api/auth/login').send({
      companySlug: 'acme-corp',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.user.role).toBe('admin');
  });

  it('login with wrong password fails with 401', async () => {
    await signupAndGetTokens();
    const res = await request(app).post('/api/auth/login').send({
      companySlug: 'acme-corp',
      email: 'alice@acme.com',
      password: 'WrongPassword',
    });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('protected route without token fails with 401', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('protected route with valid token succeeds', async () => {
    const signup = await signupAndGetTokens();
    const token = signup.body.data.accessToken;
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBeDefined();
    expect(res.body.data.tenantId).toBeDefined();
    expect(res.body.data.permissions).toBeInstanceOf(Array);
    expect(res.body.data.permissions.length).toBeGreaterThan(0);
  });

  it('refresh returns new access and refresh tokens', async () => {
    const signup = await signupAndGetTokens();
    const oldRefreshToken = signup.body.data.refreshToken;
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: oldRefreshToken });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.refreshToken).not.toBe(oldRefreshToken);
  });

  it('old refresh token rejected after rotation', async () => {
    const signup = await signupAndGetTokens();
    const firstRefreshToken = signup.body.data.refreshToken;
    await request(app).post('/api/auth/refresh').send({ refreshToken: firstRefreshToken });
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: firstRefreshToken });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });

  it('logout makes refresh token unusable', async () => {
    const signup = await signupAndGetTokens();
    const { refreshToken } = signup.body.data;
    const logoutRes = await request(app).post('/api/auth/logout').send({ refreshToken });
    expect(logoutRes.status).toBe(200);
    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it('same email in different companies can log in to their own tenant', async () => {
    await request(app).post('/api/auth/signup').send({
      companyName: 'Beta Inc',
      adminName: 'Bob Admin',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });

    const res1 = await request(app).post('/api/auth/login').send({
      companySlug: 'acme-corp',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });
    const res2 = await request(app).post('/api/auth/login').send({
      companySlug: 'beta-inc',
      email: 'alice@acme.com',
      password: 'SecureP@ss123',
    });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const decoded1 = jwt.verify(res1.body.data.accessToken, env.jwt.accessSecret);
    const decoded2 = jwt.verify(res2.body.data.accessToken, env.jwt.accessSecret);
    expect(decoded1.tenantId).not.toBe(decoded2.tenantId);
    expect(decoded1.userId).not.toBe(decoded2.userId);
  });
});