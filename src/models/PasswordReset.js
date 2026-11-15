/**
 * PasswordReset model — a single-use token that lets a user set a new
 * password without knowing their old one.
 *
 * WHAT THIS MODEL TRACKS:
 * - tenantId: which company this reset belongs to (tenant-plugin scoped)
 * - userId: the user this reset is for
 * - tokenHash: SHA-256 hash of the random reset token (never stored raw)
 * - expiresAt: when this reset link stops working (1 hour by default)
 * - usedAt: set when the user actually completes the reset (null until then)
 *
 * WHY HASH THE RESET TOKEN:
 * Same reason we hash invite and refresh tokens: if the database leaks,
 * the raw reset tokens are useless to attackers. They only see hashes,
 * which are one-way — no way to reverse them back into working tokens.
 * The raw token is only ever sent to the user (in the reset email/link),
 * so it never touches the database in plaintext.
 *
 * WHY usedAt (AND NOT JUST EXPIRY):
 * A token is valid until the EARLIER of: it is used, or it expires.
 * We claim it atomically with a findOneAndUpdate that requires
 * usedAt=null AND expiresAt > now, so two concurrent requests can never
 * both succeed. Once usedAt is set, the token is dead forever — even if
 * it has not yet technically expired.
 *
 * TENANT PLUGIN:
 * Applied below. Every query is automatically scoped to the current
 * tenant from AsyncStorage. A reset token for Company A can never be
 * found or used while a Company B request is in progress.
 *
 * INDEXES:
 * - tokenHash: fast lookup when the user submits a reset link
 * - (userId, usedAt): lets us invalidate all of a user's older tokens
 * - expiresAt with TTL: MongoDB auto-deletes expired tokens so the
 *   table never fills up with dead rows
 */

import mongoose from 'mongoose';
import tenantPlugin from '../plugins/tenantPlugin.js';

const passwordResetSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
    },
    tokenHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    usedAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

// Fast lookup by hash when a reset link is submitted
passwordResetSchema.index({ tokenHash: 1 });

// Fast lookup when invalidating a user's older unused tokens
passwordResetSchema.index({ userId: 1, usedAt: 1 });

// Auto-delete rows once they pass their expiry — no cleanup job needed
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Apply the tenant filter plugin — automatic scoping to current tenant
passwordResetSchema.plugin(tenantPlugin);

const PasswordReset = mongoose.model('PasswordReset', passwordResetSchema);
export default PasswordReset;