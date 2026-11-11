/**
 * Activity routes — mounted at /api/activity.
 *
 * PERMISSION CHOICE: user:manage.
 *
 * The activity feed is an operational/audit view of who did what inside the
 * company. That is a user-administration concern, so it is gated on
 * user:manage rather than billing:view, which is about invoices and plan
 * changes. user:manage is also the narrower choice: admins already have it,
 * and members — who can do project work but not administer people — do not.
 */

import { Router } from 'express';
import protect from '../middleware/protect.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { PERMISSIONS } from '../constants/permissions.js';
import * as activityController from '../controllers/activityController.js';

const router = Router();

router.get(
  '/',
  protect,
  requirePermission(PERMISSIONS.USER_MANAGE),
  activityController.list
);

export default router;
