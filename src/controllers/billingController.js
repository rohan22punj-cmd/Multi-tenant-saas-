/**
 * Billing Controller — HTTP layer for billing endpoints.
 */

import {
  createCheckout: createCheckoutService,
  createPortal: createPortalService,
  getBillingStatus: getBillingStatusService,
} from '../services/billing.service.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';

/**
 * POST /api/billing/checkout
 * Creates a Stripe Checkout Session for upgrading to Pro.
 */
export const createCheckout = asyncHandler(async (req, res) => {
  const { url } = await createCheckoutService({ tenantId: req.user.tenantId });
  res.status(200).json({ status: 'success', data: { url } });
});

/**
 * POST /api/billing/portal
 * Creates a Stripe Billing Portal session.
 */
export const createPortal = asyncHandler(async (req, res) => {
  const { url } = await createPortalService({ tenantId: req.user.tenantId });
  res.status(200).json({ status: 'success', data: { url } });
});

/**
 * GET /api/billing
 * Returns the current billing status for the caller's tenant.
 */
export const getBillingStatus = asyncHandler(async (req, res) => {
  const status = await getBillingStatusService({ tenantId: req.user.tenantId });
  res.status(200).json({ status: 'success', data: status });
});