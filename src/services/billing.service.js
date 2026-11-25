/**
 * Billing Service — business logic for Stripe billing.
 *
 * WHAT THIS DOES:
 * Handles the business logic for billing operations: creating checkout
 * sessions, managing the customer portal, and getting billing status.
 * Controllers call these functions; they don't talk to Stripe directly.
 */

import Tenant from '../models/Tenant.js';
import { getOrCreateCustomer, createCheckoutSession, createPortalSession } from './stripe.service.js';
import AppError from '../utils/AppError.js';
import { runWithTenant, runUnscoped } from '../utils/tenantContext.js';

/**
 * Creates a Checkout Session for upgrading to Pro.
 *
 * @param {Object} params
 * @param {string} params.tenantId - the tenant's MongoDB _id
 * @returns {Object} { url } or error
 */
export async function createCheckout({ tenantId }) {
  // Find tenant (unscoped — Tenant has no tenantId)
  const tenant = await runUnscoped(
    'billing: find tenant for checkout',
    () => Tenant.findById(tenantId)
  );

  if (!tenant) {
    throw new AppError('Tenant not found', 404);
  }

  // Already Pro and active? Block.
  if (tenant.plan === 'pro' && tenant.subscriptionStatus === 'active') {
    throw new AppError('Already on Pro plan', 409);
  }

  // Get or create Stripe customer
  const customerResult = await getOrCreateCustomer(tenant);
  if (customerResult.disabled) {
    throw new AppError('Stripe billing is not configured', 503);
  }
  if (customerResult.error) {
    throw new AppError(customerResult.error, 503);
  }

  // Create checkout session
  const sessionResult = await createCheckoutSession(tenant, customerResult.customerId);
  if (sessionResult.disabled) {
    throw new AppError('Stripe billing is not configured', 503);
  }
  if (sessionResult.error) {
    throw new AppError(sessionResult.error, 503);
  }

  return { url: sessionResult.url };
}

/**
 * Creates a Billing Portal session for managing the subscription.
 *
 * @param {string} tenantId - the tenant's MongoDB _id
 * @returns {Object} { url }
 */
export async function createPortal({ tenantId }) {
  // Find tenant (unscoped — Tenant has no tenantId)
  const tenant = await runUnscoped(
    'billing: find tenant for portal',
    () => Tenant.findById(tenantId)
  );

  if (!tenant) {
    throw new AppError('Tenant not found', 404);
  }

  if (!tenant.stripeCustomerId) {
    throw new AppError('No billing account found', 404);
  }

  const sessionResult = await createPortalSession(tenant.stripeCustomerId);
  if (sessionResult.disabled) {
    throw new AppError('Stripe billing is not configured', 503);
  }
  if (sessionResult.error) {
    throw new AppError(sessionResult.error, 503);
  }

  return { url: sessionResult.url };
}

/**
 * Gets the current billing status for a tenant.
 *
 * @param {string} tenantId - the tenant's MongoDB _id
 * @returns {Object} billing status
 */
export async function getBillingStatus({ tenantId }) {
  // Find tenant inside tenant context so we get the right one
  const tenant = await runWithTenant(
    { tenantId },
    () => Tenant.findById(tenantId)
  );

  if (!tenant) {
    throw new AppError('Tenant not found', 404);
  }

  // Determine project limit based on plan
  const projectLimit = tenant.plan === 'pro' ? Infinity : 3;

  return {
    plan: tenant.plan,
    subscriptionStatus: tenant.subscriptionStatus,
    currentPeriodEnd: tenant.currentPeriodEnd,
    projectCount: tenant.projectCount,
    projectLimit,
    overLimit: tenant.projectCount > projectLimit && tenant.plan === 'free',
  };
}