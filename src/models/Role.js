/**
 * Role model — a named set of permissions that belongs to a tenant.
 *
 * Each tenant gets its own roles so companies can customize.
 * isSystemRole marks the default roles created at signup
 * (admin, member) so the UI can prevent deleting them.
 *
 * The permissions field stores an array of permission key strings
 * (e.g. ['project:create', 'project:read']). We validate that
 * every key exists in our master PERMISSIONS list.
 *
 * TENANT PLUGIN:
 * The tenantPlugin is applied below. It automatically scopes every
 * query (find, update, delete, aggregate, countDocuments, distinct)
 * to the current tenant from AsyncLocalStorage. It also:
 *   - Force-overwrites any tenantId in the caller's filter
 *   - Throws if called outside a tenant context (no silent leaks)
 *   - Blocks any attempt to change a document's tenantId
 *   - Auto-stamps tenantId on new documents (save, create, insertMany)
 *
 * FUTURE MODELS: Every new tenant-owned model (Project, Task, etc.)
 * MUST apply this plugin. Do not skip it.
 */

import mongoose from 'mongoose';
import { ALL_PERMISSIONS } from './permissions.js';
import tenantPlugin from '../plugins/tenantPlugin.js';

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Role name is required'],
      trim: true,
    },
    permissions: {
      type: [String],
      validate: {
        validator: (arr) => arr.every((key) => ALL_PERMISSIONS.includes(key)),
        message: (props) => `Invalid permission key found in: ${props.value}`,
      },
    },
    isSystemRole: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// The tenantPlugin will add the tenantId field (ObjectId, ref Tenant, required, indexed)
// if it doesn't already exist. We don't define it here to avoid duplication.

// One role name per tenant (no two roles called "admin" in the same company).
roleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

// Apply the tenant filter plugin — automatic scoping to current tenant
roleSchema.plugin(tenantPlugin);

const Role = mongoose.model('Role', roleSchema);
export default Role;
