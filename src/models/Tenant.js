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
    /**
     * Number of NON-ARCHIVED projects this tenant currently has.
     *
     * WHY A COUNTER INSTEAD OF COUNTING PROJECTS EVERY TIME:
     * Two simultaneous "create project" requests can both read "2 projects"
     * and both decide they are under the Free limit of 3, ending up with 4.
     * We prevent that race with one atomic conditional update on this single
     * document (see services/planService.js). MongoDB applies each update
     * one at a time, so the second request's `projectCount < 3` condition
     * fails once the first request has incremented it to 3.
     *
     * The counter is maintained by the app: +1 on create/unarchive,
     * -1 on archive/delete. If it ever drifts, planService recounts the
     * real projects and repairs it (self-healing).
     */
    projectCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

// The `unique: true` on the slug field already creates a unique index.
// No need for an explicit tenantSchema.index({ slug: 1 }) — that
// would duplicate the index and Mongoose would warn about it.

const Tenant = mongoose.model('Tenant', tenantSchema);
export default Tenant;
