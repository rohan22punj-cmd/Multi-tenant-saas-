/**
 * Tenant context middleware — now a thin no-op because protect.js
 * already called runWithTenant. Kept for backward compatibility
 * and clear separation of concerns (auth vs context).
 *
 * WHAT THIS DOES:
 * Simply calls next(). The async context (tenantId, userId) was
 * already established by protect middleware.
 *
 * USAGE IN ROUTES:
 *   router.use(protect, tenantContextMiddleware);
 */

const tenantContextMiddleware = (_req, _res, next) => {
  next();
};

export default tenantContextMiddleware;
