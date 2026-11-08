/**
 * Project model — a company's project/initiative.
 *
 * BELONGS TO one tenant (company). Each project sits inside one company.
 * isArchived defaults to false; archived projects are hidden from lists
 * unless the caller passes ?includeArchived=true.
 *
 * createdBy is stamped from the verified JWT (req.user.userId). It is never
 * accepted from a request body and never changed afterwards.
 *
 * TENANT PLUGIN:
 * Applied below. Every query is automatically scoped to the current tenant
 * from AsyncLocalStorage, so a user from Company A cannot read or modify
 * Company B's projects even if they know the id.
 */

import mongoose from 'mongoose';
import tenantPlugin from '../plugins/tenantPlugin.js';

const projectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Project name is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      // Optional at schema level so older/seeded rows stay valid, but the
      // create endpoint always stamps it from the token.
    },
  },
  { timestamps: true }
);

// The tenantPlugin adds the tenantId field (ObjectId, ref Tenant, required,
// indexed) if the schema does not already define it.

// List queries: newest first, always for one tenant.
projectSchema.index({ tenantId: 1, createdAt: -1 });

projectSchema.plugin(tenantPlugin);

const Project = mongoose.model('Project', projectSchema);
export default Project;
