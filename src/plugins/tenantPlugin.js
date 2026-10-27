/**
 * Tenant Filter Mongoose Plugin — automatic tenant scoping for all queries.
 *
 * WHAT THIS DOES:
 * When applied to a schema, this plugin makes EVERY Mongoose operation
 * automatically scoped to the current tenant (from AsyncLocalStorage via
 * getTenantId()). The caller never needs to pass tenantId manually.
 *
 * WHAT IS A MONGOOSE PLUGIN?
 * A plugin is a function that receives a schema and can:
 *   - add fields, indexes, virtuals
 *   - attach pre/post middleware (hooks) that run before/after operations
 *   - add static/instance methods
 *   - modify query behavior via query middleware
 * Plugins are applied with schema.plugin(pluginFn).
 *
 * WHAT IS A "HOOK" (MIDDLEWARE)?
 * Mongoose middleware (hooks) are functions that run automatically at
 * specific points in the lifecycle of a query or document operation.
 *   - PRE hooks run BEFORE the operation (e.g., pre('find'), pre('save'))
 *   - POST hooks run AFTER the operation
 * They receive `next` — call next() to continue, or next(err) to abort.
 *
 * WHY FORCE-SET tenantId INSTEAD OF JUST ADDING IT?
 * If we merely added tenantId to the filter when missing, a malicious or
 * buggy caller could pass their own tenantId and see another company's data.
 * By FORCE-OVERWRITING any tenantId in the caller's filter, we guarantee
 * the current request's tenant ALWAYS wins. The caller's tenantId is ignored.
 *
 * WHY THROW WHEN NO CONTEXT?
 * getTenantId() throws if called outside a tenant context. If we caught that
 * and ran an unfiltered query, we'd silently leak ALL tenants' data — a
 * catastrophic security bug. Throwing makes the bug loud and immediate at
 * the exact line that forgot to set context, not in production weeks later.
 */

import mongoose from 'mongoose';
import { getTenantId, isUnscoped } from '../utils/tenantContext.js';

const READ_METHODS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
];

const WRITE_METHODS = [
  'save',
  'create',
  'insertMany',
];

/**
 * Adds a tenantId filter to the query object, FORCE-OVERWRITING any
 * existing tenantId the caller may have passed.
 *
 * @param {Object} filter - Mongoose query filter (will be mutated)
 * @param {mongoose.Types.ObjectId} tenantId - current tenant from context
 */
function applyTenantFilter(filter, tenantId) {
  if (filter && typeof filter === 'object') {
    filter.tenantId = tenantId;
  }
}

/**
 * Checks if an update document tries to modify tenantId.
 * Throws if $set, $unset, or direct replacement contains tenantId.
 *
 * @param {Object} update - Mongoose update document
 */
function assertNoTenantIdChange(update) {
  if (!update || typeof update !== 'object') return;

  // Direct replacement (replaceOne, findOneAndReplace with a plain object)
  if (update.tenantId !== undefined) {
    throw new Error('Changing tenantId is not allowed. A document can never move between tenants.');
  }

  // $set / $unset operators
  if (update.$set && update.$set.tenantId !== undefined) {
    throw new Error('Changing tenantId via $set is not allowed.');
  }
  if (update.$unset && update.$unset.tenantId !== undefined) {
    throw new Error('Unsetting tenantId is not allowed.');
  }
}

/**
 * Inserts a $match stage at the start of an aggregation pipeline.
 * If the pipeline starts with $geoNear (which MUST be first), we cannot
 * safely inject our $match before it, so we throw a clear error.
 *
 * @param {Array} pipeline - Aggregation pipeline array
 * @param {mongoose.Types.ObjectId} tenantId - current tenant from context
 */
function injectAggregateMatch(pipeline, tenantId) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    pipeline.unshift({ $match: { tenantId } });
    return;
  }

  const firstStage = pipeline[0];
  const firstStageKey = firstStage && Object.keys(firstStage)[0];

  // $geoNear MUST be the first stage in a pipeline — we cannot inject
  // a $match before it. Throw a clear error so the developer knows
  // to either run it unscoped (via runUnscoped) or restructure.
  if (firstStageKey === '$geoNear') {
    throw new Error(
      'Aggregation pipeline starts with $geoNear, which must be the first stage. ' +
      'Cannot automatically inject tenant $match. Use runUnscoped() with an explicit reason.'
    );
  }

  // Safe to inject at position 0
  pipeline.unshift({ $match: { tenantId } });
}

export function tenantPlugin(schema) {
  // ──────────────────────────────────────────────────────────────
  // a) Add tenantId field if not already present
  // ──────────────────────────────────────────────────────────────
  if (!schema.path('tenantId')) {
    schema.add({
      tenantId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Tenant',
        required: true,
        index: true,
      },
    });
  }

  // ──────────────────────────────────────────────────────────────
  // b) READ & WRITE queries — pre hooks to inject tenantId filter
  // ──────────────────────────────────────────────────────────────
  for (const method of READ_METHODS) {
    schema.pre(method, function (next) {
      // If unscoped, skip tenant filtering entirely
      if (isUnscoped()) {
        return next();
      }
      // `this` is the Query object for static methods, Document for instance methods
      const tenantId = getTenantId();

      // For query middleware, `this` is the Query; filter is in this._conditions or passed as first arg
      // We need to handle both: query middleware gets filter in this.getFilter()
      if (typeof this.getFilter === 'function') {
        const filter = this.getFilter();
        applyTenantFilter(filter, tenantId);
      }
      next();
    });
  }

  // Also hook updateOne/updateMany/deleteOne/deleteMany which may receive filter as first arg
  // The above covers them since they use query middleware, but we also need to catch
  // the case where filter is passed directly. The getFilter() approach handles it.

  // ──────────────────────────────────────────────────────────────
  // c) estimatedDocumentCount — throw on scoped models
  // ──────────────────────────────────────────────────────────────
  schema.pre('estimatedDocumentCount', function (next) {
    if (isUnscoped()) {
      return next();
    }
    next(new Error(
      'estimatedDocumentCount() cannot be filtered by tenant and is disabled on tenant-scoped models. ' +
      'Use countDocuments() instead, or wrap in runUnscoped() with a valid reason.'
    ));
  });

  // ──────────────────────────────────────────────────────────────
  // d) aggregate — inject $match as first stage (unless $geoNear)
  // ──────────────────────────────────────────────────────────────
  schema.pre('aggregate', function (next) {
    if (isUnscoped()) {
      return next();
    }
    const tenantId = getTenantId();
    const pipeline = this.pipeline();
    injectAggregateMatch(pipeline, tenantId);
    next();
  });

  // ──────────────────────────────────────────────────────────────
  // e) WRITES of new documents — save, create, insertMany
  // ──────────────────────────────────────────────────────────────
  schema.pre('save', function (next) {
    if (isUnscoped()) {
      return next();
    }
    let tenantId;
    try {
      tenantId = getTenantId();
    } catch (err) {
      console.error('[tenantPlugin pre-save] getTenantId failed:', err.message);
      return next(err);
    }

    if (this.isNew) {
      // New document — stamp tenantId
      if (this.tenantId && !this.tenantId.equals(tenantId)) {
        return next(new Error(
          `Document tenantId (${this.tenantId}) does not match current context (${tenantId}). ` +
          'Cannot create a document for a different tenant.'
        ));
      }
      this.tenantId = tenantId;
    } else {
      // Existing document — ensure tenantId is not being changed
      if (this.isModified('tenantId')) {
        return next(new Error('Changing tenantId is not allowed. A document can never move between tenants.'));
      }
    }
    next();
  });

  // create() and insertMany() go through save() internally for each doc,
  // but we also hook at the static level to catch bulk operations and
  // ensure the filter passed to create/insertMany doesn't contain a different tenantId.
  schema.pre('create', function (next, docs) {
    if (isUnscoped()) {
      return next();
    }
    const tenantId = getTenantId();
    const documents = Array.isArray(docs) ? docs : [docs];
    for (const doc of documents) {
      if (doc && doc.tenantId && !doc.tenantId.equals(tenantId)) {
        return next(new Error(
          `Document tenantId (${doc.tenantId}) does not match current context (${tenantId}). ` +
          'Cannot create a document for a different tenant.'
        ));
      }
      if (doc) doc.tenantId = tenantId;
    }
    next();
  });

  schema.pre('insertMany', function (next, docs) {
    if (isUnscoped()) {
      return next();
    }
    const tenantId = getTenantId();
    const documents = Array.isArray(docs) ? docs : [docs];
    for (const doc of documents) {
      if (doc && doc.tenantId && !doc.tenantId.equals(tenantId)) {
        return next(new Error(
          `Document tenantId (${doc.tenantId}) does not match current context (${tenantId}). ` +
          'Cannot create a document for a different tenant.'
        ));
      }
      if (doc) doc.tenantId = tenantId;
    }
    next();
  });

  // ──────────────────────────────────────────────────────────────
  // f) Block tenantId changes on updates — pre hooks for update methods
  // ──────────────────────────────────────────────────────────────
  const updateMethods = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'];
  for (const method of updateMethods) {
    schema.pre(method, function (next) {
      if (isUnscoped()) {
        return next();
      }
      // For query middleware, update document is in this._update
      const update = this.getUpdate();
      assertNoTenantIdChange(update);
      next();
    });
  }

  // ──────────────────────────────────────────────────────────────
  // g) bulkWrite — not supported on scoped models
  // ──────────────────────────────────────────────────────────────
  // bulkWrite takes an array of arbitrary operations (insertOne, updateOne,
  // deleteOne, replaceOne) each with their own filter/update documents.
  // Intercepting and rewriting every operation's filter/update safely is
  // complex and error-prone. Instead, we throw a clear error directing
  // the developer to use runUnscoped() with an explicit reason if they
  // truly need bulkWrite (rare — usually for migrations or seeding).
  schema.pre('bulkWrite', function (next) {
    if (isUnscoped()) {
      return next();
    }
    next(new Error(
      'bulkWrite() is not supported on tenant-scoped models. ' +
      'It accepts arbitrary operations that cannot be safely auto-scoped. ' +
      'Use runUnscoped(reason, callback) with a valid justification if absolutely necessary.'
    ));
  });
}

export default tenantPlugin;