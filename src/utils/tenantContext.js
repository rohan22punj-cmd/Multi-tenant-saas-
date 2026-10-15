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
import logger from '../config/logger.js';

const asyncLocalStorage = new AsyncLocalStorage();

// Internal flag to track when we're intentionally running unscoped
let unscopedDepth = 0;

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
  if (unscopedDepth > 0) {
    // Inside runUnscoped — return undefined so the plugin knows
    // not to apply a filter. The plugin checks isUnscoped() instead.
    return undefined;
  }
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
 * current request. Returns undefined if inside runUnscoped.
 * Throws if no context is set and not unscoped.
 */
export function getContext() {
  if (unscopedDepth > 0) {
    return undefined;
  }
  const store = asyncLocalStorage.getStore();
  if (!store) {
    throw new Error(
      'getContext() called outside a tenant context.'
    );
  }
  return store;
}

/**
 * Checks if we are currently inside a runUnscoped block.
 * Used by the tenant plugin to skip tenant filtering.
 */
export function isUnscoped() {
  return unscopedDepth > 0;
}

/**
 * ESCAPE HATCH — runs a callback WITHOUT any tenant filter.
 *
 * WHAT THIS DOES:
 * Temporarily disables the tenant context so Mongoose queries run
 * unfiltered (see ALL tenants' data). This is DANGEROUS and should
 * only be used for:
 *   - System-level operations (migrations, seeding, cron jobs)
 *   - Cross-tenant analytics/reporting (with strict access control)
 *   - Operations on the Tenant model itself (which has no tenantId)
 *
 * WHY IT EXISTS:
 * The Tenant model has no tenantId — it IS the tenant. Creating or
 * looking up tenants by slug must run unscoped. A few other rare
 * system cases also need it.
 *
 * SAFETY MEASURES:
 * - reason (string) is REQUIRED — forces the developer to justify it
 * - Logs a WARNING with the reason so every usage is auditable
 * - Single function name (runUnscoped) makes it trivial to grep:
 *     grep -r "runUnscoped" src/
 * - Nesting is tracked so nested calls work correctly
 *
 * @param {string} reason - REQUIRED human-readable justification
 * @param {Function} callback - async function to run unscoped
 * @returns {Promise<*>} - whatever the callback returns
 */
export async function runUnscoped(reason, callback) {
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    throw new Error('runUnscoped() requires a non-empty reason string');
  }

  unscopedDepth++;
  logger.warn({ reason, unscopedDepth }, 'runUnscoped: executing without tenant filter');

  try {
    // Run with an empty store (no tenantId) — getTenantId will return undefined
    return await asyncLocalStorage.run({}, callback);
  } finally {
    unscopedDepth--;
  }
}

export default asyncLocalStorage;
