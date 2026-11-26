/**
 * Role routes — CRUD for custom roles.
 * All routes require protect + requirePermission(PERMISSIONS.USER_MANAGE).
 */

import { Router } from 'express';
import {
  listRoles,
  listPermissions,
  createRole,
  updateRole,
  deleteRole,
} from '../controllers/roleController.js';
import protect from '../middleware/protect.js';
import { requirePermission } from '../middleware/requirePermission.js';
import PERMISSIONS from '../constants/permissions.js';

const router = Router();

router.use(protect);
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

// GET /api/roles — list all roles in company with user counts
router.get('/', listRoles);

// GET /api/permissions — list all available permission keys
router.get('/permissions', listPermissions);

// POST /api/roles — create custom role
router.post('/', createRole);

// PATCH /api/roles/:id — update role name and/or permissions
router.patch('/:id', updateRole);

// DELETE /api/roles/:id — delete custom role
router.delete('/:id', deleteRole);

export default router;