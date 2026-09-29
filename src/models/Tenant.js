/**
 * Tenant model — represents one company/organization.
 *
 * Every tenant gets a human-readable slug (used in URLs later)
 * and a plan that controls feature limits (Free vs Pro).
 * stripeCustomerId links this tenant to a Stripe customer
 * so we can manage billing in Phase 6.
 */

import mongoose from 'mongoose';

const tenantSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Tenant name is required'],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, 'Tenant slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers, and hyphens'],
    },
    plan: {
      type: String,
      enum: ['free', 'pro'],
      default: 'free',
    },
    stripeCustomerId: {
      type: String,
      default: null,
    },
  },
  { timestamps: true },
);

// The `unique: true` on the slug field already creates a unique index.
// No need for an explicit tenantSchema.index({ slug: 1 }) — that
// would duplicate the index and Mongoose would warn about it.

const Tenant = mongoose.model('Tenant', tenantSchema);
export default Tenant;
