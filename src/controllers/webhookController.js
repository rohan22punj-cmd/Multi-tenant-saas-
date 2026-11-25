/**
 * Stripe Webhook Controller — HTTP layer for Stripe webhooks.
 *
 * WHAT THIS DOES:
 * Receives raw Stripe webhook payload, verifies signature, and delegates
 * to the webhook service for exactly-once processing.
 *
 * WHY RAW BODY:
 * Stripe signature verification requires the EXACT raw request body.
 * express.raw() provides this without parsing. The body is a Buffer.
 */

import { constructWebhookEvent } from '../services/stripe.service.js';
import { handleStripeEvent } from '../services/webhook.service.js';
import logger from '../config/logger.js';
import AppError from '../utils/AppError.js';

/**
 * POST /api/webhooks/stripe
 * Handles Stripe webhook events.
 *
 * Must be mounted BEFORE express.json() with express.raw()
 * so the raw body is available for signature verification.
 */
export async function handleStripeWebhook(req, res, next) {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    logger.warn('Stripe webhook missing stripe-signature header');
    throw new AppError('Missing Stripe signature', 400);
  }

  let event;

  // Verify signature and construct event
  try {
    // req.body is a Buffer from express.raw()
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    logger.warn({ err: err.message }, 'Stripe webhook signature verification failed');
    throw new AppError('Invalid Stripe signature', 400);
  }

  // Process the event with exactly-once guarantees
  try {
    const result = await handleStripeEvent(event);
    res.status(200).json({ received: true, ...result });
  } catch (err) {
    // Errors from handleStripeEvent (500) are thrown intentionally
    // so Stripe retries. The error handler will convert to 500.
    throw err;
  }
}

export default { handleStripeWebhook };