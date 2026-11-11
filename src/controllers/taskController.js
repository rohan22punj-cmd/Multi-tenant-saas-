/**
 * Task HTTP layer — thin controllers.
 *
 * Routes call one service function each; the service owns every rule
 * (project membership, assignee validity, immutable fields, logging).
 */

import asyncHandler from '../utils/asyncHandler.js';
import * as taskService from '../services/taskService.js';

export const create = asyncHandler(async (req, res) => {
  const task = await taskService.createTask({
    projectId: req.params.projectId,
    body: req.body,
    actorId: req.user.userId,
  });
  res.status(201).json({ status: 'success', data: { task } });
});

export const listForProject = asyncHandler(async (req, res) => {
  const result = await taskService.listProjectTasks({
    projectId: req.params.projectId,
    query: req.query,
  });
  res.status(200).json({ status: 'success', data: result });
});

export const listMine = asyncHandler(async (req, res) => {
  const result = await taskService.listMyTasks({
    userId: req.user.userId,
    query: req.query,
  });
  res.status(200).json({ status: 'success', data: result });
});

export const getOne = asyncHandler(async (req, res) => {
  const task = await taskService.getTask({ id: req.params.id });
  res.status(200).json({ status: 'success', data: { task } });
});

export const update = asyncHandler(async (req, res) => {
  const task = await taskService.updateTask({
    id: req.params.id,
    body: req.body,
    actorId: req.user.userId,
  });
  res.status(200).json({ status: 'success', data: { task } });
});

export const remove = asyncHandler(async (req, res) => {
  await taskService.deleteTask({
    id: req.params.id,
    actorId: req.user.userId,
  });
  res.status(200).json({ status: 'success', data: { deleted: true } });
});
