/**
 * Invite model — a pending invitation to join a tenant with a specific role.
 *
 * WHAT THIS MODEL TRACKS:
 * - tenantId: which company this invite belongs to (tenant-plugin scoped)
 * - email: the invitee's email address
 * - roleId: which role they're being invited into
 * - invitedBy: the user Id who sent the invite
 * - tokenHash: SHA-256 hash of the random invite token (never stored raw)
 * - expiresAt: when this invite expires (7 days by default)
 * - acceptedAt: set when the invite is accepted (null until then)
 *
 * WHY HASH THE INVITE TOKEN:
 * Same reason we hash refresh tokens: if the database leaks, the raw
 * invite tokens are useless to attackers. They can only see hashes,
 * which are one-way — no way to reverse them back into working tokens.
 *
 * TENANT PLUGIN:
 * Applied below. Every query is automatically scoped to the current
 * tenant from AsyncLocalStorage. The invitee's company is always
 * enforced by the stored tenantId — a user from Company A cannot
 * "find" Company B's invites.
 *
 * TOKEN REUSE PREVENTION:
 * acceptedAt is set on success. An atomic findOneAndUpdate with
 * acceptedAt=null claim ensures only one person can accept even with
 * concurrent requests.
 */

import mongoose from 'mongoose';
import tenantPlugin from '../plugins/tenantPlugin.js';
import { ALL_PERMISSIONS } from './permissions.js';

const inviteSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      required: [true, 'Role ID is required'],
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Inviter user ID is required'],
    },
    tokenHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    acceptedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Index on tokenHash for fast lookup by hash
inviteSchema.index({ tokenHash: 1 });

// Apply the tenant filter plugin — automatic scoping to current tenant
inviteSchema.plugin(tenantPlugin);

const Invite = mongoose.model('Invite', inviteSchema);
export default Invite;