/**
 * Tenant context backed by Node's AsyncLocalStorage.
 *
 * WHAT THIS DOES:
 * Every incoming HTTP request runs inside its own "async context."
 * After the auth middleware decodes the JWT and learns which tenant
 * this request belongs to, it stores tenantId here. Any code that
 * runs later in that same request — controllers, services, even
 * Mongoose plugins — can call getTenantId() to read it without the
 * caller having to thread tenantId through every function argument.
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
 * the provided tenantId. Typically called by middleware.
 *
 * @param {string} tenantId - Mongoose ObjectId as a string
 * @param {Function} callback - the rest of the request handling
 */
export function runWithTenant(tenantId, callback) {
  return asyncLocalStorage.run({ tenantId }, callback);
}

/**
 * Reads the tenantId stored by runWithTenant for the current
 * request. Returns undefined if called outside a tenant context
 * (e.g. during startup or in tests that skip the middleware).
 */
export function getTenantId() {
  const store = asyncLocalStorage.getStore();
  return store?.tenantId;
}

export default asyncLocalStorage;
