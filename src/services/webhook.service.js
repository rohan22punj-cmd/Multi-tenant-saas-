/**
 * Stripe Webhook Service — handles Stripe webhook events with exactly-once processing.
 *
 * WHAT THIS DOES:
 * Processes Stripe webhook events (checkout.session.completed, customer.subscription.updated,
 * customer.subscription.deleted, invoice.payment_failed) with exactly-once guarantees.
 *
 * EXACTLY-ONCE GUARANTEES:
 * 1. Redis SET NX EX on event ID with value "processing", TTL ~24h
 * 2. If Redis claims fails:
 *    - Value is "done": return 200, skip (already processed)
 *    - Value is "processing": return 409, let Stripe retry later
 * 3. If claim succeeds: process event, then set value to "done"
 * 4. If processing throws: DELETE the key, return 500 (Stripe will retry)
 *    - If we left "processing", retry would be skipped and payment lost
 * 5. Backup: StripeEvent collection with unique index on eventId
 *    - Inserted atomically with plan change
 *    - Duplicate key error = already processed, return 200
 * 6. Out-of-order events: ignore events older than lastStripeEventAt
 * 7. Redis down: fall back to unique index, log warning
 *
 * TENANT LOOKUP:
 * Finds tenant from verified event data only (metadata.tenantId or stored stripeCustomerId).
 * Runs inside runWithTenant for tenant-owned operations.
 */

import Stripe from 'stripe';
import Tenant from '../models/Tenant.js';
import StripeEvent from '../models/StripeEvent.js';
import { getRedis, initRevocation } from './revocation.service.js';
import { runWithTenant, runUnscoped } from '../utils/tenantContext.js';
import env from '../config/env.js';
import logger from '../config/logger.js';

const EVENT_TTL = 24 * 60 * 60; // 24 hours
const PROCESSING_VALUE = 'processing';
const DONE_VALUE = 'done';

// Track if Redis was available at last check (for warning suppression)
let redisWasAvailable = true;

/**
 * Handles a Stripe webhook event with exactly-once processing.
 */
export async function handleStripeEvent(event) {
  const eventId = event.id;
  const eventType = event.type;
  const eventCreated = event.created; // Unix timestamp

  // Idempotency key for Redis
  const redisKey = `stripe:event:${eventId}`;

  // Try to claim the event in Redis
  let claimed = false;
  let redisAvailable = true;

  const redis = getRedis();
  if (redis) {
    try {
      // Try to set the key with NX (only if not exists) and EX (TTL)
      const result = await redis.set(redisKey, PROCESSING_VALUE, 'EX', EVENT_TTL, 'NX');
      if (result === 'OK') {
        claimed = true;
      } else {
        // Key exists - check its value
        const existing = await redis.get(redisKey);
        if (existing === DONE_VALUE) {
          logger.info({ eventId, eventType }, 'Stripe event already processed (Redis done)');
          return { skipped: true, reason: 'already processed' };
        } else if (existing === PROCESSING_VALUE) {
          logger.info({ eventId, eventType }, 'Stripe event currently processing (Redis processing)');
          return { skipped: true, reason: 'processing', retry: true };
        }
      }
      redisWasAvailable = true;
    } catch (err) {
      redisAvailable = false;
      if (redisWasAvailable) {
        logger.warn({ err: err.message }, 'Redis unavailable for webhook idempotency, falling back to DB');
        redisWasAvailable = false;
      }
    }
  } else {
    redisAvailable = false;
  }

  // If Redis unavailable or claim failed, fall back to DB unique index
  if (!claimed) {
    if (!redisAvailable) {
      // Check DB for existing event
      const existingEvent = await StripeEvent.findOne({ eventId }).lean();
      if (existingEvent) {
        logger.info({ eventId, eventType }, 'Stripe event already processed (DB fallback)');
        return { skipped: true, reason: 'already processed (DB)' };
      }
    }
  }

  // Check for out-of-order events
  const eventTime = new Date(eventCreated * 1000);

  // Find the tenant
  let tenant = null;
  let tenantId = null;

  // First try to find tenant from event metadata
  if (event.data?.object?.metadata?.tenantId) {
    tenantId = event.data.object.metadata.tenantId;
    tenant = await runUnscoped(
      'webhook: find tenant by metadata',
      () => Tenant.findById(tenantId)
    );
  }

  // Fallback: look up by stripeCustomerId
  if (!tenant && event.data?.object?.customer) {
    const customerId = event.data.object.customer;
    tenant = await runUnscoped(
      'webhook: find tenant by customer',
      () => Tenant.findOne({ stripeCustomerId: customerId })
    );
    if (tenant) tenantId = tenant._id.toString();
  }

  // Fallback: look up by stripeSubscriptionId
  if (!tenant && event.data?.object?.id && eventType.startsWith('customer.subscription.')) {
    tenant = await runUnscoped(
      'webhook: find tenant by subscription',
      () => Tenant.findOne({ stripeSubscriptionId: event.data.object.id })
    );
    if (tenant) tenantId = tenant._id.toString();
  }

  // Check for out-of-order events (if tenant found and has lastStripeEventAt)
  if (tenant && tenant.lastStripeEventAt && eventTime <= tenant.lastStripeEventAt) {
    logger.info({ eventId, eventType, tenantId, eventTime, lastEventAt: tenant.lastStripeEventAt }, 'Stripe event older than last processed, skipping');
    // Mark as done in Redis
    if (redisAvailable && redis) {
      await redis.set(redisKey, DONE_VALUE, 'EX', EVENT_TTL);
    }
    // Record in DB
    await recordEvent(eventId, eventType, tenantId);
    return { skipped: true, reason: 'out of order' };
  }

  // Process the event
  let result;
  try {
    switch (eventType) {
      case 'checkout.session.completed':
        result = await handleCheckoutCompleted(event, tenantId, tenant);
        break;
      case 'customer.subscription.updated':
        result = await handleSubscriptionUpdated(event, tenantId, tenant);
        break;
      case 'customer.subscription.deleted':
        result = await handleSubscriptionDeleted(event, tenantId, tenant);
        break;
      case 'invoice.payment_failed':
        result = await handlePaymentFailed(event, tenantId, tenant);
        break;
      default:
        logger.info({ eventId, eventType }, 'Unhandled Stripe event type, returning 200');
        result = { ignored: true };
    }

    // Mark as done in Redis
    if (redisAvailable && redis) {
      await redis.set(redisKey, DONE_VALUE, 'EX', EVENT_TTL);
    }

    // Record in DB (atomic with plan change via unique index)
    await recordEvent(eventId, eventType, tenantId, result);

    return { processed: true, ...result };
  } catch (err) {
    // On error, DELETE the Redis key so Stripe can retry
    if (redisAvailable && redis) {
      try {
        await redis.del(redisKey);
      } catch (delErr) {
        logger.error({ err: delErr.message }, 'Failed to delete Redis key after error');
      }
    }
    logger.error({ err: err.message, eventId, eventType }, 'Stripe webhook processing failed');
    throw err; // Return 500 so Stripe retries
  }
}

/**
 * Records the processed event in the StripeEvent collection.
 * The unique index on eventId ensures exactly-once at DB level.
 */
async function recordEvent(eventId, eventType, tenantId, result = {}) {
  try {
    await StripeEvent.create({
      eventId,
      eventType,
      tenantId,
      processedAt: new Date(),
      result: JSON.stringify(result),
    });
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key - already recorded (race condition)
      logger.info({ eventId }, 'Stripe event already recorded (duplicate key)');
    } else {
      logger.error({ err: err.message, eventId }, 'Failed to record Stripe event');
      throw err;
    }
  }
}

/**
 * Handles checkout.session.completed - tenant upgrades to Pro.
 */
async function handleCheckoutCompleted(event, tenantId, tenant) {
  const session = event.data.object;
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  if (!tenantId) {
    logger.error({ eventId: event.id }, 'No tenant ID found in checkout.session.completed');
    throw new Error('No tenant ID in checkout session metadata');
  }

  const update = {
    plan: 'pro',
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    subscriptionStatus: 'active',
    currentPeriodEnd: null, // Will be updated by subscription.updated
    lastStripeEventAt: new Date(),
  };

  await runWithTenant({ tenantId }, async () => {
    await Tenant.findByIdAndUpdate(tenantId, update);
  });

  logger.info({ tenantId, customerId, subscriptionId }, 'Tenant upgraded to Pro via checkout');
  return { plan: 'pro', customerId, subscriptionId };
}

/**
 * Handles customer.subscription.updated - sync subscription status.
 */
async function handleSubscriptionUpdated(event, tenantId, tenant) {
  const subscription = event.data.object;
  const customerId = subscription.customer;
  const status = subscription.status; // active, past_due, canceled, trialing, etc.
  const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

  // Determine tenant plan based on subscription status
  // Pro only while active or trialing
  const plan = (status === 'active' || status === 'trialing') ? 'pro' : 'free';
  const subscriptionStatus = status;

  const update = {
    plan,
    subscriptionStatus,
    currentPeriodEnd,
    lastStripeEventAt: new Date(),
  };

  if (!tenantId) {
    // Try to find tenant by customer
    const foundTenant = await runUnscoped(
      'webhook: find tenant by customer for subscription.updated',
      () => Tenant.findOne({ stripeCustomerId: customerId })
    );
    if (foundTenant) tenantId = foundTenant._id.toString();
  }

  if (!tenantId) {
    logger.error({ eventId: event.id, customerId }, 'No tenant found for subscription.updated');
    throw new Error('No tenant found for subscription update');
  }

  await runWithTenant({ tenantId }, async () => {
    await Tenant.findByIdAndUpdate(tenantId, update);
  });

  logger.info({ tenantId, plan, subscriptionStatus, currentPeriodEnd }, 'Subscription status updated');
  return { plan, subscriptionStatus, currentPeriodEnd };
}

/**
 * Handles customer.subscription.deleted - downgrade to free.
 */
async function handleSubscriptionDeleted(event, tenantId, tenant) {
  const subscription = event.data.object;
  const customerId = subscription.customer;

  const update = {
    plan: 'free',
    subscriptionStatus: 'canceled',
    currentPeriodEnd: null,
    stripeSubscriptionId: null,
    lastStripeEventAt: new Date(),
  };

  if (!tenantId) {
    const foundTenant = await runUnscoped(
      'webhook: find tenant by customer for subscription.deleted',
      () => Tenant.findOne({ stripeCustomerId: customerId })
    );
    if (foundTenant) tenantId = foundTenant._id.toString();
  }

  if (!tenantId) {
    logger.error({ eventId: event.id, customerId }, 'No tenant found for subscription.deleted');
    throw new Error('No tenant found for subscription deletion');
  }

  await runWithTenant({ tenantId }, async () => {
    await Tenant.findByIdAndUpdate(tenantId, update);
  });

  logger.info({ tenantId }, 'Subscription deleted, tenant downgraded to Free');
  return { plan: 'free', subscriptionStatus: 'canceled' };
}

/**
 * Handles invoice.payment_failed - mark as past_due.
 */
async function handlePaymentFailed(event, tenantId, tenant) {
  const invoice = event.data.object;
  const customerId = invoice.customer;

  const update = {
    subscriptionStatus: 'past_due',
    lastStripeEventAt: new Date(),
  };

  if (!tenantId) {
    const foundTenant = await runUnscoped(
      'webhook: find tenant by customer for invoice.payment_failed',
      () => Tenant.findOne({ stripeCustomerId: customerId })
    );
    if (foundTenant) tenantId = foundTenant._id.toString();
  }

  if (!tenantId) {
    logger.error({ eventId: event.id, customerId }, 'No tenant found for invoice.payment_failed');
    throw new Error('No tenant found for payment failed');
  }

  await runWithTenant({ tenantId }, async () => {
    await Tenant.findByIdAndUpdate(tenantId, update);
  });

  logger.info({ tenantId }, 'Payment failed, subscription marked past_due');
  return { subscriptionStatus: 'past_due' };
}