/**
 * Project business logic.
 *
 * Controllers stay thin: they read the request and write the response.
 * Everything that decides *what is allowed* lives here, so it can be tested
 * without HTTP and reused by other entry points later.
 *
 * Tenant safety: every query runs inside the request's AsyncLocalStorage
 * tenant context (set by protect.js), so the Mongoose tenant plugin scopes
 * Project/Task queries automatically. No tenantId is ever read from input.
 */

import Project from '../models/Project.js';
import Task from '../models/Task.js';
import AppError from '../utils/AppError.js';
import { getTenantId } from '../utils/tenantContext.js';
import { reserveProjectSlot, releaseProjectSlot } from './planService.js';
import { logActivity } from './activityService.js';

const CREATE_FIELDS = ['name', 'description'];
const UPDATE_FIELDS = ['name', 'description', 'isArchived'];

function assertKnownFields(body, allowed) {
  const unknown = Object.keys(body || {}).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new AppError('Unknown fields: ' + unknown.join(', '), 400);
  }
}

function normalizePagination(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const requestedLimit = parseInt(query.limit, 10) || 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  return { page, limit };
}

export async function createProject({ body, actorId }) {
  assertKnownFields(body, CREATE_FIELDS);

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    throw new AppError('Name is required', 400);
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    throw new AppError('Description must be a string', 400);
  }

  const tenantId = getTenantId();
  const slot = await reserveProjectSlot(tenantId);

  if (!slot.reserved) {
    return { limitReached: true, limit: slot.limit, plan: slot.plan };
  }

  let project;
  try {
    project = await Project.create({
      name,
      description: body.description,
      createdBy: actorId,
    });
  } catch (err) {
    // Compensate: we reserved a slot but created nothing, so hand it back.
    await releaseProjectSlot(tenantId);
    throw err;
  }

  await logActivity({
    actorId,
    action: 'project.created',
    entityType: 'project',
    entityId: project._id,
    meta: { name: project.name },
  });

  return { project };
}

export async function listProjects({ query }) {
  const { page, limit } = normalizePagination(query);
  const includeArchived = query.includeArchived === 'true';

  const filter = includeArchived ? {} : { isArchived: false };
  const total = await Project.countDocuments(filter);
  const items = await Project.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  return { items, page, limit, total };
}

export async function getProject({ id }) {
  const project = await Project.findById(id);
  if (!project) {
    throw new AppError('Project not found', 404);
  }
  return project;
}

export async function updateProject({ id, body, actorId }) {
  assertKnownFields(body, UPDATE_FIELDS);

  const project = await Project.findById(id);
  if (!project) {
    throw new AppError('Project not found', 404);
  }

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      throw new AppError('Name is required', 400);
    }
    project.name = name;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw new AppError('Description must be a string', 400);
    }
    project.description = body.description;
  }

  if (body.isArchived !== undefined && typeof body.isArchived !== 'boolean') {
    throw new AppError('isArchived must be a boolean', 400);
  }

  const wasArchived = project.isArchived;
  const willBeArchived =
    body.isArchived === undefined ? wasArchived : body.isArchived;

  const archivingNow = !wasArchived && willBeArchived;
  const unarchivingNow = wasArchived && !willBeArchived;

  const tenantId = getTenantId();

  // Un-archiving brings the project back into the plan's count, so it needs
  // a free slot — otherwise a company could dodge the limit by archiving and
  // re-activating projects.
  if (unarchivingNow) {
    const slot = await reserveProjectSlot(tenantId);
    if (!slot.reserved) {
      return { limitReached: true, limit: slot.limit, plan: slot.plan };
    }
  }

  project.isArchived = willBeArchived;

  try {
    await project.save();
  } catch (err) {
    if (unarchivingNow) {
      await releaseProjectSlot(tenantId);
    }
    throw err;
  }

  // Archiving removes the project from the plan's count.
  if (archivingNow) {
    await releaseProjectSlot(tenantId);
  }

  const changedFields = Object.keys(body);

  await logActivity({
    actorId,
    action: archivingNow ? 'project.archived' : 'project.updated',
    entityType: 'project',
    entityId: project._id,
    meta: { name: project.name, changedFields, isArchived: project.isArchived },
  });

  return { project };
}

export async function deleteProject({ id, actorId }) {
  const project = await Project.findById(id);
  if (!project) {
    throw new AppError('Project not found', 404);
  }

  const wasArchived = project.isArchived;

  // Delete the project's tasks first, then the project.
  //
  // WHY NOT A TRANSACTION: MongoDB multi-document transactions require a
  // replica set, which the test/dev setup does not have. The failure window
  // here is tiny: if the process dies after deleting tasks but before
  // deleting the project, the project remains with no tasks — visible and
  // recoverable. The reverse order would be worse (tasks orphaned under a
  // project that no longer exists). With a replica set available, wrap both
  // in a session transaction for true atomicity.
  await Task.deleteMany({ projectId: project._id });
  await Project.deleteOne({ _id: project._id });

  // Archived projects were not counted, so only active ones free a slot.
  if (!wasArchived) {
    await releaseProjectSlot(getTenantId());
  }

  await logActivity({
    actorId,
    action: 'project.deleted',
    entityType: 'project',
    entityId: project._id,
    meta: { name: project.name },
  });

  return { deleted: true };
}
