/**
 * Plan-limit tests.
 *
 * Proves the Free plan caps non-archived projects at 3, that the 4th create
 * returns the exact 402 payload, that two concurrent creates cannot both
 * slip through, that archiving/deleting frees a slot, and that the plan is
 * read from the database on each request rather than from the JWT.
 */

import request from 'supertest';
import app from '../src/app.js';
import Tenant from '../src/models/Tenant.js';
import { connectTestDB, clearTestDB, closeTestDB } from './setup.js';
import { auth, signupCompany, createProject } from './helpers.js';

let company;

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  company = await signupCompany();
});

async function setPlan(tenantId, plan) {
  // Tenant has no tenantId of its own and no tenant plugin, so this is a
  // plain update — nothing to scope.
  await Tenant.updateOne({ _id: tenantId }, { $set: { plan } });
}

describe('Free plan (max 3 projects)', () => {
  test('the 4th project is rejected with 402 and the exact payload', async () => {
    for (const name of ['One', 'Two', 'Three']) {
      expect((await createProject(company.token, { name })).status).toBe(201);
    }

    const res = await createProject(company.token, { name: 'Four' });

    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      error: 'Plan limit reached',
      limit: 3,
      plan: 'free',
    });
  });

  test('two simultaneous creates cannot both pass', async () => {
    await createProject(company.token, { name: 'One' });
    await createProject(company.token, { name: 'Two' });

    const [a, b] = await Promise.all([
      createProject(company.token, { name: 'Race A' }),
      createProject(company.token, { name: 'Race B' }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 402]);

    const list = await request(app).get('/api/projects').set(auth(company.token));
    expect(list.body.data.total).toBe(3);
  });

  test('archiving a project frees a slot', async () => {
    const created = [];
    for (const name of ['One', 'Two', 'Three']) {
      created.push((await createProject(company.token, { name })).body.data.project._id);
    }

    expect((await createProject(company.token, { name: 'Blocked' })).status).toBe(402);

    const archive = await request(app)
      .patch(`/api/projects/${created[0]}`)
      .set(auth(company.token))
      .send({ isArchived: true });
    expect(archive.status).toBe(200);

    expect((await createProject(company.token, { name: 'Fits now' })).status).toBe(201);
  });

  test('un-archiving when the plan is full is rejected', async () => {
    const created = [];
    for (const name of ['One', 'Two', 'Three']) {
      created.push((await createProject(company.token, { name })).body.data.project._id);
    }

    await request(app)
      .patch(`/api/projects/${created[0]}`)
      .set(auth(company.token))
      .send({ isArchived: true });

    expect((await createProject(company.token, { name: 'Replacement' })).status).toBe(201);

    const restore = await request(app)
      .patch(`/api/projects/${created[0]}`)
      .set(auth(company.token))
      .send({ isArchived: false });

    expect(restore.status).toBe(402);
    expect(restore.body.error).toBe('Plan limit reached');
  });

  test('deleting a project frees a slot', async () => {
    const ids = [];
    for (const name of ['One', 'Two', 'Three']) {
      ids.push((await createProject(company.token, { name })).body.data.project._id);
    }

    expect((await createProject(company.token, { name: 'Blocked' })).status).toBe(402);

    expect((await request(app).delete(`/api/projects/${ids[1]}`).set(auth(company.token))).status).toBe(200);

    expect((await createProject(company.token, { name: 'Fits now' })).status).toBe(201);
  });

  test('deleting an archived project does not free a second slot', async () => {
    const ids = [];
    for (const name of ['One', 'Two', 'Three']) {
      ids.push((await createProject(company.token, { name })).body.data.project._id);
    }

    await request(app)
      .patch(`/api/projects/${ids[0]}`)
      .set(auth(company.token))
      .send({ isArchived: true });

    // Archived projects are not counted, so deleting one must not free
    // another slot — otherwise a company could exceed the limit.
    await request(app).delete(`/api/projects/${ids[0]}`).set(auth(company.token));

    expect((await createProject(company.token, { name: 'One more' })).status).toBe(201);
    expect((await createProject(company.token, { name: 'Two more' })).status).toBe(402);
  });
});

describe('plan source of truth', () => {
  test('Pro plan has no project limit', async () => {
    await setPlan(company.tenantId, 'pro');

    for (let i = 0; i < 6; i += 1) {
      expect((await createProject(company.token, { name: `Pro ${i}` })).status).toBe(201);
    }
  });

  test('upgrading the database plan takes effect without a new token', async () => {
    // The token was issued while the tenant was on Free, so it is the
    // clearest proof the plan is read from the DB rather than the JWT.
    for (const name of ['One', 'Two', 'Three']) {
      expect((await createProject(company.token, { name })).status).toBe(201);
    }
    expect((await createProject(company.token, { name: 'Blocked' })).status).toBe(402);

    await setPlan(company.tenantId, 'pro');

    // Same token, no refresh: now allowed.
    expect((await createProject(company.token, { name: 'Allowed after upgrade' })).status).toBe(201);
  });
});
