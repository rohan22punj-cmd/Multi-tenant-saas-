/**
 * StripeEvent model — records processed Stripe webhook events for idempotency.
 *
 * WHAT THIS DOES:
 * Provides a database-level backup for exactly-once webhook processing.
 * The unique index on eventId ensures that even if Redis fails or is cleared,
 * duplicate events are detected and safely ignored.
 *
 * WHY THIS IS NEEDED:
 * Redis is fast but volatile. If Redis restarts or is cleared, we lose the
 * "processing" and "done" keys. The StripeEvent collection provides a durable
 * backup that survives restarts.
 *
 * FIELDS:
 * - eventId: Stripe's unique event ID (e.g., "evt_123...") — unique index
 * - eventType: e.g., "checkout.session.completed"
 * - tenantId: the tenant this event affected (nullable for unknown customers)
 * - processedAt: when we processed it
 * - result: JSON string of the processing result (for debugging)
 */

import mongoose from 'mongoose';

const stripeEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true, // Enforces exactly-once at database level
      index: true,
    },
    eventType: {
      type: String,
      required: true,
    },
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      default: null,
    },
    processedAt: {
      type: Date,
      default: Date.now,
    },
    result: {
      type: String, // JSON string of processing result
      default: null,
    },
  },
  { timestamps: true },
);

// Unique index on eventId is created by `unique: true` above
// No need for additional indexes

const StripeEvent = mongoose.model('StripeEvent', stripeEventSchema);
export default StripeEvent;