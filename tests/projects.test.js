/**
 * Project endpoint tests.
 *
 * Covers: authentication and permission gates, tenant isolation, creation,
 * pagination, archive visibility, the updatable-field whitelist, cascade
 * delete of a project's tasks, and ObjectId validation.
 */

import request from 'supertest';
import app from '../src/app.js';
import { connectTestDB, clearTestDB, closeTestDB } from './setup.js';
import {
  auth,
  signupCompany,
  loginAsMember,
  createProject,
  createTask,
} from './helpers.js';

let company;
let member;

beforeAll(async () => {
  await connectTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

beforeEach(async () => {
  await clearTestDB();
  company = await signupCompany();
  member = await loginAsMember(company);
});

describe('authentication and permissions', () => {
  test('requests without a token get 401', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
    expect((await request(app).post('/api/projects').send({ name: 'x' })).status).toBe(401);
  });

  test('a member can read projects but cannot create them', async () => {
    expect((await request(app).get('/api/projects').set(auth(member.token))).status).toBe(200);

    const res = await createProject(member.token, { name: 'Nope' });
    expect(res.status).toBe(403);
  });

  test('a member cannot update or delete projects', async () => {
    const created = await createProject(company.token, { name: 'Keep me' });
    const id = created.body.data.project._id;

    const patch = await request(app)
      .patch(`/api/projects/${id}`)
      .set(auth(member.token))
      .send({ name: 'Renamed' });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/api/projects/${id}`)
      .set(auth(member.token));
    expect(del.status).toBe(403);
  });
});

describe('POST /api/projects', () => {
  test('creates a project stamped with the caller tenant and user', async () => {
    const res = await createProject(company.token, {
      name: 'Website rewrite',
      description: 'Replace the marketing site',
    });

    expect(res.status).toBe(201);
    const project = res.body.data.project;
    expect(project.name).toBe('Website rewrite');
    expect(project.description).toBe('Replace the marketing site');
    expect(project.isArchived).toBe(false);
    expect(project.tenantId).toBe(company.tenantId);
    expect(project.createdBy).toBe(company.userId);
  });

  test('rejects a client-supplied tenantId / createdBy as unknown fields', async () => {
    const withTenant = await createProject(company.token, {
      name: 'Sneaky',
      tenantId: '000000000000000000000000',
    });
    expect(withTenant.status).toBe(400);

    const withCreator = await createProject(company.token, {
      name: 'Sneaky',
      createdBy: company.userId,
    });
    expect(withCreator.status).toBe(400);
  });

  test('rejects a missing or blank name', async () => {
    expect((await createProject(company.token, {})).status).toBe(400);
    expect((await createProject(company.token, { name: '   ' })).status).toBe(400);
  });
});

describe('GET /api/projects', () => {
  test('lists newest first with pagination metadata', async () => {
    for (const name of ['First', 'Second', 'Third']) {
      expect((await createProject(company.token, { name })).status).toBe(201);
    }

    const page1 = await request(app)
      .get('/api/projects?page=1&limit=2')
      .set(auth(company.token));

    expect(page1.status).toBe(200);
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.page).toBe(1);
    expect(page1.body.data.limit).toBe(2);
    expect(page1.body.data.total).toBe(3);
    expect(page1.body.data.items[0].name).toBe('Third');

    const page2 = await request(app)
      .get('/api/projects?page=2&limit=2')
      .set(auth(company.token));
    expect(page2.body.data.items).toHaveLength(1);
    expect(page2.body.data.items[0].name).toBe('First');
  });

  test('defaults to 20 per page and caps limit at 100', async () => {
    const res = await request(app)
      .get('/api/projects?limit=500')
      .set(auth(company.token));
    expect(res.body.data.limit).toBe(100);

    const defaults = await request(app)
      .get('/api/projects')
      .set(auth(company.token));
    expect(defaults.body.data.limit).toBe(20);
    expect(defaults.body.data.page).toBe(1);
  });

  test('hides archived projects unless includeArchived=true', async () => {
    const active = await createProject(company.token, { name: 'Active' });
    const archived = await createProject(company.token, { name: 'Archived' });
    await request(app)
      .patch(`/api/projects/${archived.body.data.project._id}`)
      .set(auth(company.token))
      .send({ isArchived: true });

    const hidden = await request(app).get('/api/projects').set(auth(company.token));
    expect(hidden.body.data.total).toBe(1);
    expect(hidden.body.data.items[0]._id).toBe(active.body.data.project._id);

    const shown = await request(app)
      .get('/api/projects?includeArchived=true')
      .set(auth(company.token));
    expect(shown.body.data.total).toBe(2);
  });

  test('never returns another company\'s projects', async () => {
    const other = await signupCompany();
    await createProject(other.token, { name: 'Other company project' });
    await createProject(company.token, { name: 'Mine' });

    const res = await request(app).get('/api/projects').set(auth(company.token));
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items[0].name).toBe('Mine');
  });
});

describe('GET /api/projects/:id', () => {
  test('returns the project to its owner', async () => {
    const created = await createProject(company.token, { name: 'Look at me' });
    const id = created.body.data.project._id;

    const res = await request(app).get(`/api/projects/${id}`).set(auth(company.token));
    expect(res.status).toBe(200);
    expect(res.body.data.project._id).toBe(id);
  });

  test('returns 404 for another company\'s project', async () => {
    const other = await signupCompany();
    const created = await createProject(other.token, { name: 'Not yours' });

    const res = await request(app)
      .get(`/api/projects/${created.body.data.project._id}`)
      .set(auth(company.token));
    expect(res.status).toBe(404);
  });

  test('returns 400 for a malformed id', async () => {
    const res = await request(app)
      .get('/api/projects/not-an-object-id')
      .set(auth(company.token));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/projects/:id', () => {
  test('updates name, description and isArchived', async () => {
    const created = await createProject(company.token, { name: 'Old', description: 'Old desc' });
    const id = created.body.data.project._id;

    const res = await request(app)
      .patch(`/api/projects/${id}`)
      .set(auth(company.token))
      .send({ name: 'New', description: 'New desc', isArchived: true });

    expect(res.status).toBe(200);
    expect(res.body.data.project.name).toBe('New');
    expect(res.body.data.project.description).toBe('New desc');
    expect(res.body.data.project.isArchived).toBe(true);
  });

  test('rejects unknown fields, including tenantId and createdBy', async () => {
    const created = await createProject(company.token, { name: 'Guarded' });
    const id = created.body.data.project._id;

    for (const body of [
      { colour: 'red' },
      { tenantId: '000000000000000000000000' },
      { createdBy: '000000000000000000000000' },
    ]) {
      const res = await request(app)
        .patch(`/api/projects/${id}`)
        .set(auth(company.token))
        .send(body);
      expect(res.status).toBe(400);
    }

    const after = await request(app).get(`/api/projects/${id}`).set(auth(company.token));
    expect(after.body.data.project.createdBy).toBe(company.userId);
    expect(after.body.data.project.tenantId).toBe(company.tenantId);
  });

  test('returns 404 for another company\'s project and leaves it untouched', async () => {
    const other = await signupCompany();
    const created = await createProject(other.token, { name: 'Theirs' });
    const id = created.body.data.project._id;

    const res = await request(app)
      .patch(`/api/projects/${id}`)
      .set(auth(company.token))
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(404);

    const check = await request(app).get(`/api/projects/${id}`).set(auth(other.token));
    expect(check.body.data.project.name).toBe('Theirs');
  });
});

describe('DELETE /api/projects/:id', () => {
  test('deletes the project and all of its tasks', async () => {
    const created = await createProject(company.token, { name: 'Doomed' });
    const id = created.body.data.project._id;

    const task = await createTask(company.token, id, { title: 'Goes with it' });
    expect(task.status).toBe(201);

    const del = await request(app).delete(`/api/projects/${id}`).set(auth(company.token));
    expect(del.status).toBe(200);

    expect((await request(app).get(`/api/projects/${id}`).set(auth(company.token))).status).toBe(404);
    expect(
      (await request(app)
        .get(`/api/tasks/${task.body.data.task._id}`)
        .set(auth(company.token))).status
    ).toBe(404);
  });

  test('returns 404 for another company\'s project', async () => {
    const other = await signupCompany();
    const created = await createProject(other.token, { name: 'Safe' });

    const res = await request(app)
      .delete(`/api/projects/${created.body.data.project._id}`)
      .set(auth(company.token));
    expect(res.status).toBe(404);

    expect(
      (await request(app).get('/api/projects').set(auth(other.token))).body.data.total
    ).toBe(1);
  });
});
