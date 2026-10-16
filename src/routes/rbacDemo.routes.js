import { Router } from 'express';
import { requirePermission } from '../middleware/requirePermission.js';

const router = Router();

// ─── Demo routes – PROVE permission checks work ───────────────────────
// These are test-only routes to be deleted once real resource routes exist.

// GET /api/demo/read – needs project:read permission
router.get(
  '/read',
  requirePermission('project:read'),
  (_req, res) => {
    res.status(200).json({ message: 'Read allowed' });
  }
);

// DELETE /api/demo/project – needs project:delete permission
router.delete(
  '/project',
  requirePermission('project:delete'),
  (_req, res) => {
    res.status(200).json({ message: 'Project deleted' });
  }
);

// GET /api/demo/billing – needs billing:view permission
router.get(
  '/billing',
  requirePermission('billing:view'),
  (_req, res) => {
    res.status(200).json({ message: 'Billing viewed' });
  }
);

export default router;