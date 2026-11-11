/**
 * Activity HTTP layer.
 *
 * Read-only by design — the ActivityLog model blocks updates and deletes.
 * The tenant plugin on ActivityLog scopes every query to the caller's company,
 * so no tenantId ever comes from the request.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ActivityLog from '../models/ActivityLog.js';

export const list = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const requestedLimit = parseInt(req.query.limit, 10) || 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  const total = await ActivityLog.countDocuments({});
  const items = await ActivityLog.find({})
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  res.status(200).json({ status: 'success', data: { items, page, limit, total } });
});
