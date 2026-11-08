/**
 * ActivityLog model — append-only audit trail.
 *
 * One entry per significant action (project created/updated/archived/deleted,
 * task created/updated/deleted, ...). Entries are NEVER updated or deleted:
 * if something needs correcting, a new entry explains the correction.
 *
 * meta holds only small, harmless facts (names, changed field lists, old/new
 * status). Never passwords, tokens, or full request bodies.
 *
 * TENANT PLUGIN:
 * Applied below, so every read is scoped to the current tenant. A company can
 * only ever see its own activity.
 */

import mongoose from 'mongoose';
import tenantPlugin from '../plugins/tenantPlugin.js';
import { isUnscoped } from '../utils/tenantContext.js';

const activityLogSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Actor user ID is required'],
    },
    action: {
      type: String,
      required: [true, 'Action is required'],
      // e.g. "project.created", "task.deleted"
    },
    entityType: {
      type: String,
      required: [true, 'Entity type is required'],
      // e.g. "project", "task"
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'Entity ID is required'],
    },
    meta: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

// Newest-first listing for one tenant.
activityLogSchema.index({ tenantId: 1, createdAt: -1 });

activityLogSchema.plugin(tenantPlugin);

// ─── Append-only enforcement ───
// Any attempt to mutate or remove a log entry throws, so a bug (or a
// developer with a delete call) cannot rewrite history. runUnscoped() is
// still allowed for test teardown / migrations, which are deliberate,
// audited operations rather than normal request traffic.
const BLOCKED_OPERATIONS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
];

for (const operation of BLOCKED_OPERATIONS) {
  activityLogSchema.pre(operation, async function () {
    if (isUnscoped()) return;
    throw new Error(
      'ActivityLog is append-only: entries cannot be updated or deleted.'
    );
  });
}

const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);
export default ActivityLog;
