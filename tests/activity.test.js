/**
 * Activity-feed tests.
 *
 * Covers: which actions are logged, that the actor comes from the token,
 * that sensitive data never lands in meta, the permission gate, tenant-only
 * scoping, newest-first pagination, and the rule that a failing log write
 * must not fail the main operation.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../src/app.js';
import ActivityLog from '../src/models/ActivityLog.js';
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

afterEach(() => {
  jest.restoreAllMocks();
});

async function getActivity(token, query = '') {
  return request(app).get(`/api/activity${query}`).set(auth(token));
}

describe('what gets logged', () => {
  test('creating a project logs project.created with the token actor', async () => {
    const created = await createProject(company.token, { name: 'Audited project' });
    const projectId = created.body.data.project._id;

    const res = await getActivity(company.token);
    expect(res.status).toBe(200);

    const entry = res.body.data.items.find(
      (e) => e.action === 'project.created' && e.entityId === projectId
    );
    expect(entry).toBeDefined();
    expect(entry.entityType).toBe('project');
    expect(entry.actorId).toBe(company.userId);
    expect(entry.tenantId).toBe(company.tenantId);
    expect(entry.meta.name).toBe('Audited project');
  });

  test('project updates and archiving are logged', async () => {
    const created = await createProject(company.token, { name: 'Evolving' });
    const id = created.body.data.project._id;

    await request(app)
      .patch(`/api/projects/${id}`)
      .set(auth(company.token))
      .send({ name: 'Evolved' });

    await request(app)
      .patch(`/api/projects/${id}`)
      .set(auth(company.token))
      .send({ isArchived: true });

    const actions = (await getActivity(company.token, '?limit=100')).body.data.items
      .filter((e) => e.entityId === id)
      .map((e) => e.action);

    expect(actions).toContain('project.updated');
    expect(actions).toContain('project.archived');
  });

  test('task create, update and delete are logged', async () => {
    const project = await createProject(company.token, { name: 'Has tasks' });
    const projectId = project.body.data.project._id;

    const task = await createTask(company.token, projectId, { title: 'Tracked task' });
    const taskId = task.body.data.task._id;

    await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set(auth(company.token))
      .send({ status: 'done' });

    await request(app).delete(`/api/tasks/${taskId}`).set(auth(company.token));

    const entries = (await getActivity(company.token, '?limit=100')).body.data.items.filter(
      (e) => e.entityId === taskId
    );
    const actions = entries.map((e) => e.action);

    expect(actions).toContain('task.created');
    expect(actions).toContain('task.updated');
    expect(actions).toContain('task.deleted');
    expect(entries.every((e) => e.actorId === company.userId)).toBe(true);
  });

  test('deleting a project is logged', async () => {
    const project = await createProject(company.token, { name: 'Short lived' });
    const projectId = project.body.data.project._id;

    await request(app).delete(`/api/projects/${projectId}`).set(auth(company.token));

    const entries = (await getActivity(company.token, '?limit=100')).body.data.items.filter(
      (e) => e.entityId === projectId
    );
    expect(entries.map((e) => e.action)).toContain('project.deleted');
  });

  test('meta never contains passwords, tokens or the raw request body', async () => {
    await createProject(company.token, {
      name: 'Secret-free',
      description: 'Long description that is not logged verbatim',
    });

    const res = await getActivity(company.token, '?limit=100');
    const entry = res.body.data.items.find((e) => e.action === 'project.created');
    expect(entry).toBeDefined();

    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('Long description');
    expect(Object.keys(entry.meta)).toEqual(['name']);
  });
});

describe('GET /api/activity access rules', () => {
  test('requires a token and the user:manage permission', async () => {
    expect((await request(app).get('/api/activity')).status).toBe(401);
    expect((await getActivity(member.token)).status).toBe(403);
    expect((await getActivity(company.token)).status).toBe(200);
  });

  test('returns only the caller company\'s entries', async () => {
    const mine = await createProject(company.token, { name: 'Mine' });

    const other = await signupCompany();
    const theirs = await createProject(other.token, { name: 'Theirs' });

    const res = await getActivity(company.token, '?limit=100');
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);

    const entityIds = res.body.data.items.map((e) => e.entityId);
    expect(entityIds).toContain(mine.body.data.project._id);
    expect(entityIds).not.toContain(theirs.body.data.project._id);
    expect(res.body.data.items.every((e) => e.tenantId === company.tenantId)).toBe(true);
  });

  test('is paginated newest first', async () => {
    for (const name of ['One', 'Two', 'Three']) {
      await createProject(company.token, { name });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const first = await getActivity(company.token, '?page=1&limit=2');
    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.limit).toBe(2);
    expect(first.body.data.page).toBe(1);
    expect(first.body.data.total).toBeGreaterThanOrEqual(3);

    const times = first.body.data.items.map((e) => new Date(e.createdAt).getTime());
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);

    const second = await getActivity(company.token, '?page=2&limit=2');
    const secondTimes = second.body.data.items.map((e) => new Date(e.createdAt).getTime());
    expect(secondTimes[0]).toBeLessThanOrEqual(times[times.length - 1]);
  });
});

describe('logging failures do not break the main action', () => {
  test('a thrown log write still returns 201 for the project', async () => {
    jest.spyOn(ActivityLog, 'create').mockRejectedValueOnce(new Error('log write failed'));

    const res = await createProject(company.token, { name: 'Still created' });

    expect(res.status).toBe(201);
    expect(res.body.data.project.name).toBe('Still created');

    const list = await request(app).get('/api/projects').set(auth(company.token));
    expect(list.body.data.total).toBe(1);

    // The failed write left no entry, as expected.
    const activity = await getActivity(company.token);
    const entityId = res.body.data.project._id;
    expect(
      activity.body.data.items.filter((e) => e.entityId === entityId)
    ).toHaveLength(0);
  });
});
