/**
 * Task routes — mounted at /api.
 *
 * Two URL shapes:
 *   /api/projects/:projectId/tasks   (tasks belong to a project)
 *   /api/tasks/:id                   (single task operations)
 *
 * ORDER MATTERS: "/tasks/mine" is declared BEFORE "/tasks/:id", otherwise
 * the literal string "mine" would be captured as an id and rejected as an
 * invalid ObjectId. Express matches routes in declaration order.
 */

import { Router } from 'express';
import mongoose from 'mongoose';
import protect from '../middleware/protect.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { PERMISSIONS } from '../constants/permissions.js';
import AppError from '../utils/AppError.js';
import * as taskController from '../controllers/taskController.js';

const router = Router();

const validateTaskId = (req, _res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new AppError('Invalid task id', 400));
  }
  next();
};

const validateProjectId = (req, _res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.projectId)) {
    return next(new AppError('Invalid project id', 400));
  }
  next();
};

// ─── My tasks (must come before /tasks/:id) ───
router.get(
  '/tasks/mine',
  protect,
  requirePermission(PERMISSIONS.TASK_READ),
  taskController.listMine
);

// ─── Single task ───
router.get(
  '/tasks/:id',
  protect,
  requirePermission(PERMISSIONS.TASK_READ),
  validateTaskId,
  taskController.getOne
);

router.patch(
  '/tasks/:id',
  protect,
  requirePermission(PERMISSIONS.TASK_UPDATE),
  validateTaskId,
  taskController.update
);

router.delete(
  '/tasks/:id',
  protect,
  requirePermission(PERMISSIONS.TASK_DELETE),
  validateTaskId,
  taskController.remove
);

// ─── Tasks inside a project ───
router.post(
  '/projects/:projectId/tasks',
  protect,
  requirePermission(PERMISSIONS.TASK_CREATE),
  validateProjectId,
  taskController.create
);

router.get(
  '/projects/:projectId/tasks',
  protect,
  requirePermission(PERMISSIONS.TASK_READ),
  validateProjectId,
  taskController.listForProject
);

export default router;
