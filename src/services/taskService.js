/**
 * Task business logic.
 *
 * Key rules enforced here:
 *   - A task's project must belong to the caller's company (tenant plugin
 *     scopes the lookup, so another company's project id simply 404s).
 *   - An assignee must be an ACTIVE user in the same company. Every failure
 *     returns the same generic "Invalid assignee" so an attacker cannot use
 *     the endpoint to discover which user ids exist in other companies.
 *   - projectId, tenantId and createdBy can never be changed after creation.
 *
 * Controllers stay thin; this layer holds the rules.
 */

import mongoose from 'mongoose';
import Task from '../models/Task.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import AppError from '../utils/AppError.js';
import { logActivity } from './activityService.js';

const STATUSES = ['todo', 'in-progress', 'done'];
const TASK_FIELDS = [
  'title',
  'description',
  'status',
  'assigneeId',
  'dueDate',
  'position',
];

function assertKnownFields(body, allowed) {
  const unknown = Object.keys(body || {}).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AppError('Unknown fields: ' + unknown.join(', '), 400);
  }
}

function assertValidStatus(status) {
  if (!STATUSES.includes(status)) {
    throw new AppError('Invalid status', 400);
  }
}

function normalizePagination(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const requestedLimit = parseInt(query.limit, 10) || 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  return { page, limit };
}

/**
 * Returns the validated assignee ObjectId, or null when unassigning.
 * Any problem (bad id, missing user, other company, inactive) produces the
 * SAME 400 "Invalid assignee" response on purpose.
 */
async function resolveAssignee(assigneeId) {
  if (assigneeId === undefined || assigneeId === null) {
    return null;
  }

  if (
    typeof assigneeId !== 'string' ||
    !mongoose.Types.ObjectId.isValid(assigneeId)
  ) {
    throw new AppError('Invalid assignee', 400);
  }

  // Tenant plugin scopes this: a user from another company is simply not found.
  const user = await User.findById(assigneeId);
  if (!user || !user.isActive) {
    throw new AppError('Invalid assignee', 400);
  }

  return user._id;
}

async function findProjectOr404(projectId) {
  const project = await Project.findById(projectId);
  if (!project) {
    throw new AppError('Project not found', 404);
  }
  return project;
}

export async function createTask({ projectId, body, actorId }) {
  assertKnownFields(body, TASK_FIELDS);

  const project = await findProjectOr404(projectId);

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    throw new AppError('Title is required', 400);
  }

  if (body.status !== undefined) {
    assertValidStatus(body.status);
  }

  if (body.description !== undefined && typeof body.description !== 'string') {
    throw new AppError('Description must be a string', 400);
  }

  if (body.position !== undefined && typeof body.position !== 'number') {
    throw new AppError('Position must be a number', 400);
  }

  let dueDate;
  if (body.dueDate !== undefined && body.dueDate !== null) {
    dueDate = new Date(body.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      throw new AppError('Invalid due date', 400);
    }
  }

  const assigneeId = await resolveAssignee(body.assigneeId);

  const task = await Task.create({
    projectId: project._id,
    title,
    description: body.description,
    status: body.status,
    assigneeId,
    createdBy: actorId,
    dueDate,
    position: body.position,
  });

  await logActivity({
    actorId,
    action: 'task.created',
    entityType: 'task',
    entityId: task._id,
    meta: { title: task.title, projectId: String(project._id) },
  });

  return task;
}

export async function listProjectTasks({ projectId, query }) {
  const project = await findProjectOr404(projectId);

  const filter = { projectId: project._id };

  if (query.status !== undefined) {
    assertValidStatus(query.status);
    filter.status = query.status;
  }

  if (query.assigneeId !== undefined) {
    if (!mongoose.Types.ObjectId.isValid(query.assigneeId)) {
      throw new AppError('Invalid assignee', 400);
    }
    filter.assigneeId = query.assigneeId;
  }

  const { page, limit } = normalizePagination(query);

  const total = await Task.countDocuments(filter);
  const items = await Task.find(filter)
    .sort({ position: 1, createdAt: 1 })
    .skip((page - 1) * limit)
    .limit(limit);

  return { items, page, limit, total };
}

export async function listMyTasks({ userId, query }) {
  const filter = { assigneeId: userId };

  if (query.status !== undefined) {
    assertValidStatus(query.status);
    filter.status = query.status;
  }

  const { page, limit } = normalizePagination(query);

  const total = await Task.countDocuments(filter);
  const items = await Task.find(filter)
    .sort({ position: 1, createdAt: 1 })
    .skip((page - 1) * limit)
    .limit(limit);

  return { items, page, limit, total };
}

export async function getTask({ id }) {
  const task = await Task.findById(id);
  if (!task) {
    throw new AppError('Task not found', 404);
  }
  return task;
}

export async function updateTask({ id, body, actorId }) {
  assertKnownFields(body, TASK_FIELDS);

  const task = await Task.findById(id);
  if (!task) {
    throw new AppError('Task not found', 404);
  }

  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      throw new AppError('Title is required', 400);
    }
    task.title = title;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw new AppError('Description must be a string', 400);
    }
    task.description = body.description;
  }

  if (body.status !== undefined) {
    assertValidStatus(body.status);
    task.status = body.status;
  }

  if (body.position !== undefined) {
    if (typeof body.position !== 'number') {
      throw new AppError('Position must be a number', 400);
    }
    task.position = body.position;
  }

  if (body.dueDate !== undefined) {
    if (body.dueDate === null) {
      task.dueDate = undefined;
    } else {
      const dueDate = new Date(body.dueDate);
      if (Number.isNaN(dueDate.getTime())) {
        throw new AppError('Invalid due date', 400);
      }
      task.dueDate = dueDate;
    }
  }

  if (body.assigneeId !== undefined) {
    task.assigneeId = await resolveAssignee(body.assigneeId);
  }

  await task.save();

  await logActivity({
    actorId,
    action: 'task.updated',
    entityType: 'task',
    entityId: task._id,
    meta: { title: task.title, changedFields: Object.keys(body) },
  });

  return task;
}

export async function deleteTask({ id, actorId }) {
  const task = await Task.findById(id);
  if (!task) {
    throw new AppError('Task not found', 404);
  }

  await Task.deleteOne({ _id: task._id });

  await logActivity({
    actorId,
    action: 'task.deleted',
    entityType: 'task',
    entityId: task._id,
    meta: { title: task.title },
  });

  return { deleted: true };
}
