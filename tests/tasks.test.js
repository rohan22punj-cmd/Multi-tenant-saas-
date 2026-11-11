/**
 * Task endpoint tests.
 *
 * Covers: creation defaults and validation, project membership, assignee
 * rules (same company + active, always the same generic message), listing
 * with filters and ordering, "my tasks", immutable fields, isolation
 * between companies, and deletion.
 */

import request from 'supertest';
import app from '../src/app.js';
import { connectTestDB, clearTestDB, closeTestDB } from './setup.js';
import {
  auth,
  signupCompany,
  loginAsMember,
  createCompanyUser,
  createProject,
  createTask,
} from './helpers.js';

let company;
let member;
let projectId;

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
  const project = await createProject(company.token, { name: 'Task project' });
  projectId = project.body.data.project._id;
});

describe('POST /api/projects/:projectId/tasks', () => {
  test('creates a task with sensible defaults', async () => {
    const res = await createTask(company.token, projectId, { title: 'Write tests' });

    expect(res.status).toBe(201);
    const task = res.body.data.task;
    expect(task.title).toBe('Write tests');
    expect(task.status).toBe('todo');
    expect(task.projectId).toBe(projectId);
    expect(task.tenantId).toBe(company.tenantId);
    expect(task.createdBy).toBe(company.userId);
    expect(task.position).toBe(0);
  });

  test('a member with task:create can add tasks', async () => {
    const res = await createTask(member.token, projectId, { title: 'Member task' });
    expect(res.status).toBe(201);
  });

  test('returns 404 when the project belongs to another company', async () => {
    const other = await signupCompany();
    const otherProject = await createProject(other.token, { name: 'Theirs' });
    const otherProjectId = otherProject.body.data.project._id;

    const res = await createTask(company.token, otherProjectId, { title: 'Nope' });
    expect(res.status).toBe(404);
  });

  test('rejects an invalid status, missing title and malformed project id', async () => {
    expect(
      (await createTask(company.token, projectId, { title: 'x', status: 'blocked' })).status
    ).toBe(400);
    expect((await createTask(company.token, projectId, {})).status).toBe(400);
    expect((await createTask(company.token, 'not-an-id', { title: 'x' })).status).toBe(400);
  });

  test('accepts an active assignee from the same company', async () => {
    const res = await createTask(company.token, projectId, {
      title: 'Assigned',
      assigneeId: member.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.task.assigneeId).toBe(member.id);
  });

  test('rejects every invalid assignee with the same generic 400', async () => {
    const other = await signupCompany();
    const outsider = await loginAsMember(other);
    const inactive = await createCompanyUser(company, { isActive: false });

    for (const assigneeId of [
      outsider.id,
      inactive.id,
      'not-an-id',
      '000000000000000000000000',
    ]) {
      const res = await createTask(company.token, projectId, { title: 'Bad assignee', assigneeId });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Invalid assignee');
    }
  });
});

describe('GET /api/projects/:projectId/tasks', () => {
  test('filters by status and assignee, ordered by position then creation', async () => {
    await createTask(company.token, projectId, { title: 'Third', position: 3 });
    await createTask(company.token, projectId, { title: 'First', position: 1 });
    const done = await createTask(company.token, projectId, {
      title: 'Done one',
      position: 2,
      status: 'done',
      assigneeId: member.id,
    });

    const all = await request(app)
      .get(`/api/projects/${projectId}/tasks`)
      .set(auth(company.token));
    expect(all.status).toBe(200);
    expect(all.body.data.total).toBe(3);
    expect(all.body.data.items.map((t) => t.title)).toEqual(['First', 'Done one', 'Third']);

    const byStatus = await request(app)
      .get(`/api/projects/${projectId}/tasks?status=done`)
      .set(auth(company.token));
    expect(byStatus.body.data.total).toBe(1);
    expect(byStatus.body.data.items[0]._id).toBe(done.body.data.task._id);

    const byAssignee = await request(app)
      .get(`/api/projects/${projectId}/tasks?assigneeId=${member.id}`)
      .set(auth(company.token));
    expect(byAssignee.body.data.total).toBe(1);

    const paged = await request(app)
      .get(`/api/projects/${projectId}/tasks?limit=2&page=2`)
      .set(auth(company.token));
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.total).toBe(3);
  });

  test('returns 404 for another company\'s project', async () => {
    const other = await signupCompany();
    const otherProject = await createProject(other.token, { name: 'Theirs' });

    const res = await request(app)
      .get(`/api/projects/${otherProject.body.data.project._id}/tasks`)
      .set(auth(company.token));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/tasks/:id', () => {
  test('returns the task, and 404 for another company\'s task', async () => {
    const created = await createTask(company.token, projectId, { title: 'Mine' });
    const id = created.body.data.task._id;

    expect((await request(app).get(`/api/tasks/${id}`).set(auth(company.token))).status).toBe(200);

    const other = await signupCompany();
    const otherProject = await createProject(other.token, { name: 'Theirs' });
    const otherTask = await createTask(other.token, otherProject.body.data.project._id, {
      title: 'Theirs',
    });

    const res = await request(app)
      .get(`/api/tasks/${otherTask.body.data.task._id}`)
      .set(auth(company.token));
    expect(res.status).toBe(404);

    expect((await request(app).get('/api/tasks/nope').set(auth(company.token))).status).toBe(400);
  });
});

describe('PATCH /api/tasks/:id', () => {
  test('updates the allowed fields', async () => {
    const created = await createTask(company.token, projectId, { title: 'Before' });
    const id = created.body.data.task._id;

    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .set(auth(company.token))
      .send({
        title: 'After',
        description: 'Details',
        status: 'in-progress',
        assigneeId: member.id,
        dueDate: '2026-12-01T00:00:00.000Z',
        position: 5,
      });

    expect(res.status).toBe(200);
    const task = res.body.data.task;
    expect(task.title).toBe('After');
    expect(task.description).toBe('Details');
    expect(task.status).toBe('in-progress');
    expect(task.assigneeId).toBe(member.id);
    expect(task.position).toBe(5);
    expect(task.dueDate).toBe('2026-12-01T00:00:00.000Z');
  });

  test('never allows projectId, tenantId or createdBy to change', async () => {
    const created = await createTask(company.token, projectId, { title: 'Fixed' });
    const id = created.body.data.task._id;

    for (const body of [
      { projectId: '000000000000000000000000' },
      { tenantId: '000000000000000000000000' },
      { createdBy: '000000000000000000000000' },
    ]) {
      const res = await request(app)
        .patch(`/api/tasks/${id}`)
        .set(auth(company.token))
        .send(body);
      expect(res.status).toBe(400);
    }

    const after = await request(app).get(`/api/tasks/${id}`).set(auth(company.token));
    expect(after.body.data.task.projectId).toBe(projectId);
    expect(after.body.data.task.createdBy).toBe(company.userId);
    expect(after.body.data.task.tenantId).toBe(company.tenantId);
  });

  test('rejects bad status, bad dueDate, bad assignee and bad position', async () => {
    const created = await createTask(company.token, projectId, { title: 'Validate me' });
    const id = created.body.data.task._id;

    const cases = [
      { status: 'nope' },
      { dueDate: 'not-a-date' },
      { assigneeId: 'not-an-id' },
      { position: 'one' },
    ];
    for (const body of cases) {
      const res = await request(app)
        .patch(`/api/tasks/${id}`)
        .set(auth(company.token))
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  test('returns 404 for another company\'s task', async () => {
    const other = await signupCompany();
    const otherProject = await createProject(other.token, { name: 'Theirs' });
    const otherTask = await createTask(other.token, otherProject.body.data.project._id, {
      title: 'Theirs',
    });

    const res = await request(app)
      .patch(`/api/tasks/${otherTask.body.data.task._id}`)
      .set(auth(company.token))
      .send({ title: 'Hijacked' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/tasks/:id', () => {
  test('deletes a task, and requires task:delete', async () => {
    const created = await createTask(company.token, projectId, { title: 'Remove me' });
    const id = created.body.data.task._id;

    // Members have task:create/read/update but not task:delete.
    expect((await request(app).delete(`/api/tasks/${id}`).set(auth(member.token))).status).toBe(403);

    const res = await request(app).delete(`/api/tasks/${id}`).set(auth(company.token));
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/tasks/${id}`).set(auth(company.token))).status).toBe(404);
  });
});

describe('GET /api/tasks/mine', () => {
  test('returns only tasks assigned to the caller, in this company', async () => {
    await createTask(company.token, projectId, { title: 'Unassigned' });
    await createTask(company.token, projectId, { title: 'Mine', assigneeId: member.id });

    const res = await request(app).get('/api/tasks/mine').set(auth(member.token));
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items[0].title).toBe('Mine');

    const adminTasks = await request(app).get('/api/tasks/mine').set(auth(company.token));
    expect(adminTasks.body.data.total).toBe(0);
  });
});
