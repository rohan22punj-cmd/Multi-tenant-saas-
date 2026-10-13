/**
 * Tenant context backed by Node's AsyncLocalStorage.
 *
 * WHAT THIS DOES:
 * Every incoming HTTP request runs inside its own "async context."
 * After the auth middleware decodes the JWT and learns which tenant
 * this request belongs to, it stores tenantId (and userId) here. Any
 * code that runs later in that same request — controllers, services,
 * even Mongoose plugins — can call getTenantId() or getContext() to
 * read it without the caller having to thread tenantId through every
 * function argument.
 *
 * WHY AsyncLocalStorage INSTEAD OF req.tenantId:
 * req is an Express concept. Service-layer functions and Mongoose
 * plugins don't (and shouldn't) know about req. AsyncLocalStorage
 * lets us keep the data-layer code framework-agnostic while still
 * getting automatic, per-request tenant isolation.
 *
 * In Phase 3, the Mongoose "tenantFilter" plugin will call
 * getTenantId() to automatically scope every find/update/delete
 * to the current tenant. That's why we wire the plumbing now.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const asyncLocalStorage = new AsyncLocalStorage();

/**
 * Runs the given callback inside an async context that carries
 * the provided context object (tenantId, userId, …). Typically
 * called by middleware.
 *
 * @param {Object} context - e.g. { tenantId, userId }
 * @param {Function} callback - the rest of the request handling
 */
export function runWithTenant(context, callback) {
  return asyncLocalStorage.run(context, callback);
}

/**
 * Reads the tenantId stored by runWithTenant for the current
 * request. THROWS if called outside a tenant context.
 * This prevents silent undefined bugs that leak data.
 */
export function getTenantId() {
  const store = asyncLocalStorage.getStore();
  if (!store?.tenantId) {
    throw new Error(
      'getTenantId() called outside a tenant context. ' +
      'Ensure the request passed through protect + tenantContext middleware.'
    );
  }
  return store.tenantId;
}

/**
 * Returns the full context object (tenantId, userId, …) for the
 * current request. Throws if no context is set.
 */
export function getContext() {
  const store = asyncLocalStorage.getStore();
  if (!store) {
    throw new Error(
      'getContext() called outside a tenant context.'
    );
  }
  return store;
}

export default asyncLocalStorage;
