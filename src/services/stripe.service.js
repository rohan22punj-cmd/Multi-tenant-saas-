/**
 * Stripe Service — thin wrapper around the Stripe Node SDK.
 *
 * WHAT THIS DOES:
 * Provides a clean abstraction over the Stripe SDK so the rest of the
 * app never imports `stripe` directly. This makes it trivial to mock
 * in tests (just swap the module) and keeps Stripe-specific logic
 * isolated in one place.
 *
 * BEHAVIOR WHEN KEYS ARE MISSING:
 * If STRIPE_SECRET_KEY is not set, the Stripe client is null.
 * All methods return an object with { disabled: true, reason: 'Stripe not configured' }
 * instead of throwing. This lets the server start even without Stripe
 * configured, and billing routes return 503 with a clear message.
 */

import Stripe from 'stripe';
import env from '../config/env.js';
import logger from '../config/logger.js';

let stripe = null;
let isConfigured = false;

if (env.stripe.secretKey) {
  try {
    stripe = new Stripe(env.stripe.secretKey, {
      apiVersion: '2024-04-10', // pin to a stable version
      typescript: false,
    });
    isConfigured = true;
    logger.info('Stripe SDK initialized');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to initialize Stripe SDK');
    isConfigured = false;
  }
} else {
  logger.warn('STRIPE_SECRET_KEY not set; Stripe billing disabled');
}

function disabledResponse() {
  return { disabled: true, reason: 'Stripe not configured' };
}

/**
 * Creates or retrieves a Stripe customer for a tenant.
 * If the tenant already has a stripeCustomerId, returns it.
 * Otherwise creates a new customer with the tenant's email and metadata.
 */
export async function getOrCreateCustomer(tenant) {
  if (!isConfigured) return disabledResponse();

  // If tenant already has a customer ID, return it
  if (tenant.stripeCustomerId) {
    try {
      const customer = await stripe.customers.retrieve(tenant.stripeCustomerId);
      if (!customer.deleted) {
        return { customerId: customer.id };
      }
      // If customer was deleted in Stripe, fall through to create new
    } catch {
      // Not found or deleted — fall through to create new
    }
  }

  // Create new customer
  const customer = await stripe.customers.create({
    email: tenant.name ? `${tenant.slug}@billing.local` : undefined,
    metadata: {
      tenantId: tenant._id.toString(),
      slug: tenant.slug,
    },
  });

  return { customerId: customer.id };
}

/**
 * Creates a Checkout Session for subscribing to the Pro plan.
 */
export async function createCheckoutSession(tenant, customerId) {
  if (!isConfigured) return disabledResponse();

  if (!env.stripe.proPriceId) {
    return { error: 'STRIPE_PRO_PRICE_ID not configured' };
  }

  const baseUrl = env.appUrl;

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price: env.stripe.proPriceId,
        quantity: 1,
      },
    ],
    metadata: {
      tenantId: tenant._id.toString(),
    },
    client_reference_id: tenant._id.toString(),
    success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/billing/cancel`,
    allow_promotion_codes: true,
    subscription_data: {
      metadata: {
        tenantId: tenant._id.toString(),
      },
    },
  });

  return { url: session.url };
}

/**
 * Creates a Billing Portal session for the customer.
 */
export async function createPortalSession(customerId) {
  if (!isConfigured) return disabledResponse();

  const baseUrl = env.appUrl;

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/billing`,
  });

  return { url: session.url };
}

/**
 * Verifies a webhook signature and returns the parsed event.
 * Throws if the signature is invalid.
 */
export function constructWebhookEvent(payload, signature) {
  if (!isConfigured) {
    throw new Error('Stripe not configured');
  }

  if (!env.stripe.webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  }

  return stripe.webhooks.constructEvent(payload, signature, env.stripe.webhookSecret);
}

/**
 * Retrieves a subscription by ID.
 */
export async function getSubscription(subscriptionId) {
  if (!isConfigured) return disabledResponse();

  return stripe.subscriptions.retrieve(subscriptionId);
}

/**
 * Retrieves a customer by ID.
 */
export async function getCustomer(customerId) {
  if (!isConfigured) return disabledResponse();

  return stripe.customers.retrieve(customerId);
}

/**
 * Cancels a subscription.
 */
export async function cancelSubscription(subscriptionId) {
  if (!isConfigured) return disabledResponse();

  return stripe.subscriptions.cancel(subscriptionId);
}

/**
 * Checks if Stripe is configured.
 */
export function isStripeConfigured() {
  return isConfigured;
}

export { stripe };