/**
 * Billing routes — maps HTTP endpoints to controller functions.
 *
 * All routes require protect middleware + specific billing permissions.
 */

import { Router } from 'express';
import {
  createCheckout,
  createPortal,
  getBillingStatus,
} from '../controllers/billingController.js';
import protect from '../middleware/protect.js';
import { requirePermission } from '../middleware/requirePermission.js';
import PERMISSIONS from '../constants/permissions.js';

const router = Router();

// All routes require authentication
router.use(protect);

// POST /api/billing/checkout — create Pro upgrade checkout session
router.post(
  '/checkout',
  requirePermission('billing:manage'),
  createCheckout
);

// POST /api/billing/portal — create Stripe customer portal session
router.post(
  '/portal',
  requirePermission('billing:manage'),
  createPortal
);

// GET /api/billing — get billing status
router.get(
  '/',
  requirePermission('billing:view'),
  getBillingStatus
);

export default router;