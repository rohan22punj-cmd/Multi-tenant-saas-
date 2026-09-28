/**
 * User model — a person belonging to exactly one tenant.
 *
 * KEY DESIGN DECISION: The email uniqueness constraint is
 * { tenantId, email } — not just { email }. This means two
 * different companies can each have a user "alice@example.com"
 * without colliding. That's how real multi-tenant SaaS works;
 * a global unique email would break it.
 *
 * roleId points to the Role collection so we look up permissions
 * at runtime, not hard-code role names.
 */

import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: [true, 'tenantId is required'],
      index: true,
    },
    name: {
      type: String,
      required: [true, 'User name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: [true, 'Password hash is required'],
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      required: [true, 'roleId is required'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// Compound unique index: same email can exist in different tenants,
// but not twice inside the same tenant.
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);
export default User;
