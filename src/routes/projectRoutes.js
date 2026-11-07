import { Router } from 'express';
import mongoose from 'mongoose';
import Project from '../models/Project.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import AppError from '../utils/AppError.js';
import PERMISSIONS from '../constants/permissions.js';

const router = Router();

const validateObjectId = (req, _res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new AppError('Invalid project id', 400));
  }
  next();
};

router.post(
  '/',
  protect => (req, res, next) => {
    if (!req.user) return next(new AppError('Unauthorized', 401));
    next();
  },
  requirePermission(PERMISSIONS.PROJECT_CREATE),
  validateObjectId,
  async (req, res, next) => {
    try {
      const { name } = req.body;
      if (!name) return next(new AppError('Name is required', 400));
      const project = await Project.create({ name });
      res.status(201).json({ status: 'success', data: project });
    } catch (err) { next(err); }
  }
);

router.get(
  '/',
  protect => (req, res, next) => {
    if (!req.user) return next(new AppError('Unauthorized', 401));
    next();
  },
  requirePermission(PERMISSIONS.PROJECT_READ),
  async (req, res, next) => {
    try {
      const page = parseInt(req.query.page, 10) || 1;
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const includeArchived = req.query.includeArchived === 'true';
      const filter = includeArchived ? {} : { isArchived: false };
      const total = await Project.countDocuments(filter);
      const items = await Project.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);
      res.json({ status: 'success', data: { items, page, limit, total } });
    } catch (err) { next(err); }
  }
);

router.get(
  '/:id',
  protect => (req, res, next) => {
    if (!req.user) return next(new AppError('Unauthorized', 401));
    next();
  },
  requirePermission(PERMISSIONS.PROJECT_READ),
  validateObjectId,
  async (req, res, next) => {
    try {
      const project = await Project.findById(req.params.id);
      if (!project) return next(new AppError('Project not found', 404));
      res.json({ status: 'success', data: project });
    } catch (err) { next(err); }
  }
);

router.patch(
  '/:id',
  protect => (req, res, next) => {
    if (!req.user) return next(new AppError('Unauthorized', 401));
    next();
  },
  requirePermission(PERMISSIONS.PROJECT_UPDATE),
  validateObjectId,
  async (req, res, next) => {
    try {
      const allowed = ['name', 'description', 'isArchived'];
      const updates = Object.keys(req.body).reduce((acc, key) => {
        if (allowed.includes(key)) acc[key] = req.body[key];
        return acc;
      }, {});
      const disallowed = Object.keys(req.body).filter(k => !allowed.includes(k));
      if (disallowed.length > 0) return next(new AppError(`Unknown fields: ${disallowed.join(', ')}', 400));
      if (updates.tenantId || updates.createdBy) return next(new AppError('Changing tenantId/createdBy not allowed', 400));
      const project = await Project.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true, runValidators: true });
      if (!project) return next(new AppError('Project not found', 404));
      res.json({ status: 'success', data: project });
    } catch (err) { next(err); }
  }
);

router.delete(
  '/:id',
  protect => (req, res, next) => {
    if (!req.user) return next(new AppError('Unauthorized', 401));
    next();
  },
  requirePermission(PERMISSIONS.PROJECT_DELETE),
  validateObjectId,
  async (req, res, next) => {
    try {
      await Task.deleteMany({ projectId: req.params.id });
      const project = await Project.findByIdAndDelete(req.params.id);
      if (!project) return next(new AppError('Project not found', 404));
      res.json({ status: 'success', data: { deleted: true } });
    } catch (err) { next(err); }
  }
);

export default router;