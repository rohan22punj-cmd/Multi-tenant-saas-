/**
 * User routes — deactivate and reactivate endpoints.
 *
 * Both routes require:
 *   1. protect        — valid JWT access token
 *   2. requirePermission(USER_MANAGE) — caller must be an admin or have explicit manage rights
 *
 * The :id param is validated as a MongoDB ObjectId before the controller
 * runs. An invalid format returns 400 immediately, saving a pointless DB round-trip.
 */

import { Router } from 'express';
import mongoose from 'mongoose';
import { deactivate, reactivate } from '../controllers/userController.js';
import protect from '../middleware/protect.js';
import { requirePermission } from '../middleware/requirePermission.js';
import PERMISSIONS from '../constants/permissions.js';
import AppError from '../utils/AppError.js';

const router = Router();

// Validate :id is a well-formed ObjectId — catches typos before the controller
const validateObjectId = (req, _res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new AppError('Invalid user id', 400));
  }
  next();
};

const guardChain = [protect, requirePermission(PERMISSIONS.USER_MANAGE), validateObjectId];

router.patch('/:id/deactivate', ...guardChain, deactivate);
router.patch('/:id/reactivate', ...guardChain, reactivate);

export default router;
