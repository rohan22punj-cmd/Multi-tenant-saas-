/**
 * Project routes.
 *
 * Middleware order on every route:
 *   protect           → verifies the JWT, sets req.user + tenant context
 *   requirePermission → checks the specific permission key
 *   validateId        → rejects malformed ObjectIds with 400 (never reaches DB)
 *   controller        → thin handler
 *
 * Permissions are checked by KEY, never by role name: roles can be renamed or
 * redefined, permissions are the stable contract.
 */

import { Router } from 'express';
import mongoose from 'mongoose';
import protect from '../middleware/protect.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { PERMISSIONS } from '../constants/permissions.js';
import AppError from '../utils/AppError.js';
import * as projectController from '../controllers/projectController.js';

const router = Router();

/** Rejects ids that cannot be a MongoDB ObjectId. */
const validateProjectId = (req, _res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new AppError('Invalid project id', 400));
  }
  next();
};

router.post(
  '/',
  protect,
  requirePermission(PERMISSIONS.PROJECT_CREATE),
  projectController.create
);

router.get(
  '/',
  protect,
  requirePermission(PERMISSIONS.PROJECT_READ),
  projectController.list
);

router.get(
  '/:id',
  protect,
  requirePermission(PERMISSIONS.PROJECT_READ),
  validateProjectId,
  projectController.getOne
);

router.patch(
  '/:id',
  protect,
  requirePermission(PERMISSIONS.PROJECT_UPDATE),
  validateProjectId,
  projectController.update
);

router.delete(
  '/:id',
  protect,
  requirePermission(PERMISSIONS.PROJECT_DELETE),
  validateProjectId,
  projectController.remove
);

export default router;
