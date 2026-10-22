import { Router } from 'express';
import { requirePermission } from '../middleware/requirePermission.js';
import protect from '../middleware/protect.js';

const router = Router();

// ─── Demo routes – PROVE permission checks work ───────────────────────
// These are test-only routes to be deleted once real resource routes exist.
// Each route requires protect.js to run first (sets req.user from JWT),
// then requirePermission to check the specific permission.

// GET /api/demo/read – needs project:read permission
router.get(
  '/read',
  protect,
  requirePermission('project:read'),
  (_req, res) => {
    res.status(200).json({ message: 'Read allowed' });
  }
);

// DELETE /api/demo/project – needs project:delete permission
router.delete(
  '/project',
  protect,
  requirePermission('project:delete'),
  (_req, res) => {
    res.status(200).json({ message: 'Project deleted' });
  }
);

// GET /api/demo/billing – needs billing:view permission
router.get(
  '/billing',
  protect,
  requirePermission('billing:view'),
  (_req, res) => {
    res.status(200).json({ message: 'Billing viewed' });
  }
);

export default router;