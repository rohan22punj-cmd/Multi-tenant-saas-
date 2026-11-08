/**
 * Activity log writer.
 *
 * WHY THIS SWALLOWS ERRORS:
 * The audit trail is valuable, but it is not the reason the user clicked
 * "Create project". If the log write fails (disk full, transient DB error,
 * validation bug), failing the whole request would mean the project was
 * created but the client saw a 500 — and a retry would create a duplicate.
 * So a logging failure is recorded through the existing pino logger and the
 * main operation still succeeds.
 *
 * The trade-off: a failed log leaves a gap in the audit trail. The
 * structured error below is what an operator uses to find and backfill it.
 */

import ActivityLog from '../models/ActivityLog.js';
import logger from '../config/logger.js';
import { getTenantId } from '../utils/tenantContext.js';

export async function logActivity({
  actorId,
  action,
  entityType,
  entityId,
  meta = {},
}) {
  try {
    await ActivityLog.create({
      tenantId: getTenantId(),
      actorId,
      action,
      entityType,
      entityId,
      meta,
    });
  } catch (err) {
    logger.error(
      { err, action, entityType, entityId, actorId },
      'Failed to write activity log'
    );
  }
}
