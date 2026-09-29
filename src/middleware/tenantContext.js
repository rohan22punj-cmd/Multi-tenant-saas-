/**
 * Tenant context middleware — bridges req.user → AsyncLocalStorage.
 *
 * WHAT THIS DOES:
 * After the protect middleware decodes the JWT and sets req.user
 * (which includes tenantId), this middleware takes that tenantId
 * and stores it in Node's AsyncLocalStorage via runWithTenant().
 *
 * Everything that runs downstream — controllers, services, and
 * (in Phase 3) Mongoose plugins — can call getTenantId() from
 * src/utils/tenantContext.js to read the current tenant without
 * needing access to the req object.
 *
 * WHY THIS IS A SEPARATE MIDDLEWARE:
 * - protect.js handles AUTH (is the user valid?).
 * - This handles CONTEXT (which tenant are we operating on?).
 * Keeping them separate means:
 *   • We can test auth logic without AsyncLocalStorage
 *   • We can test tenant scoping without JWTs
 *   • Each middleware has a single, clear responsibility
 *
 * USAGE IN ROUTES:
 *   router.use(protect, tenantContextMiddleware);
 * or per-route:
 *   router.get('/things', protect, tenantContextMiddleware, controller);
 */

import { runWithTenant } from '../utils/tenantContext.js';

const tenantContextMiddleware = (req, _res, next) => {
  const tenantId = req.user?.tenantId;

  if (!tenantId) {
    // This shouldn't happen if protect ran first, but be safe.
    return next(new Error('tenantId missing from req.user'));
  }

  // Run the rest of this request inside an async context
  // that carries the tenantId.
  runWithTenant(tenantId, () => next());
};

export default tenantContextMiddleware;
