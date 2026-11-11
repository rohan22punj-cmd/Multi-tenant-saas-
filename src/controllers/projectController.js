/**
 * Project HTTP layer — thin controllers.
 *
 * Each handler does only three things: read what it needs off the request,
 * call the matching service function, and shape the HTTP response. All rules
 * (plan limits, validation, logging) live in projectService so they can be
 * tested without HTTP.
 */

import asyncHandler from '../utils/asyncHandler.js';
import * as projectService from '../services/projectService.js';

export const create = asyncHandler(async (req, res) => {
  const result = await projectService.createProject({
    body: req.body,
    actorId: req.user.userId,
  });

  if (result.limitReached) {
    // Exact shape required by the plan-limit contract.
    return res.status(402).json({
      error: 'Plan limit reached',
      limit: result.limit,
      plan: result.plan,
    });
  }

  res.status(201).json({ status: 'success', data: { project: result.project } });
});

export const list = asyncHandler(async (req, res) => {
  const result = await projectService.listProjects({ query: req.query });
  res.status(200).json({ status: 'success', data: result });
});

export const getOne = asyncHandler(async (req, res) => {
  const project = await projectService.getProject({ id: req.params.id });
  res.status(200).json({ status: 'success', data: { project } });
});

export const update = asyncHandler(async (req, res) => {
  const result = await projectService.updateProject({
    id: req.params.id,
    body: req.body,
    actorId: req.user.userId,
  });

  if (result.limitReached) {
    return res.status(402).json({
      error: 'Plan limit reached',
      limit: result.limit,
      plan: result.plan,
    });
  }

  res.status(200).json({ status: 'success', data: { project: result.project } });
});

export const remove = asyncHandler(async (req, res) => {
  await projectService.deleteProject({
    id: req.params.id,
    actorId: req.user.userId,
  });
  res.status(200).json({ status: 'success', data: { deleted: true } });
});
