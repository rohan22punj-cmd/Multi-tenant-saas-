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
 */

import mongoose from 'mongoose';
import { ALL_PERMISSIONS } from './permissions.js';

const roleSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: [true, 'tenantId is required'],
      index: true,
    },
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

// One role name per tenant (no two roles called "admin" in the same company).
roleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

const Role = mongoose.model('Role', roleSchema);
export default Role;
