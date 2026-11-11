/**
 * Plan enforcement service.
 *
 * The plan is read from the Tenant document in MongoDB on every check — NOT
 * from the JWT. Access tokens live for 15 minutes and bake in the plan at
 * issuance time; if we trusted the token, a company that upgraded (or was
 * downgraded) in Stripe would keep the old limits until they re-logged in.
 * Reading the Tenant row makes plan changes take effect immediately.
 *
 * RACE CONDITION — why an atomic counter:
 * The obvious "count projects, then insert" approach can overshoot: the Free
 * limit is 3, so two simultaneous creates both count 2 projects, both decide
 * they fit, and the company ends up with 4. Instead we keep a
 * `projectCount` field on the Tenant and reserve a slot with ONE atomic
 * conditional update:
 *
 *     findOneAndUpdate({ _id, projectCount: { $lt: limit } }, { $inc: { projectCount: 1 } })
 *
 * MongoDB serializes updates to a single document, so exactly one of two
 * concurrent requests can move the counter from 2 to 3. The other gets null
 * and is rejected with 402. No transaction (and therefore no replica set)
 * is required.
 *
 * IMPORTANT: we never "recount and retry" on the rejection path. A recount
 * cannot tell the difference between (a) the counter really drifted and
 * (b) another request has already reserved a slot but has not inserted its
 * project yet. Treating (b) as (a) would hand out the same slot twice and
 * break the guarantee above. Drift is avoided instead by always releasing
 * the slot on every failure path (see releaseProjectSlot callers), so a
 * client that races and loses simply retries after the winner commits.
 */

import Tenant from '../models/Tenant.js';
import AppError from '../utils/AppError.js';
import { getPlanLimits } from '../config/plans.js';

/**
 * Reads the tenant's current plan from the database.
 * Throws 404 if the tenant no longer exists.
 */
export async function getTenantPlan(tenantId) {
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) {
    throw new AppError('Tenant not found', 404);
  }
  return tenant;
}

/**
 * Reserves one non-archived project slot for the tenant.
 *
 * Returns { reserved: true, limit, plan } on success, or
 * { reserved: false, limit, plan } when the plan limit is reached.
 */
export async function reserveProjectSlot(tenantId) {
  const tenant = await getTenantPlan(tenantId);
  const limit = getPlanLimits(tenant.plan).maxProjects;

  // Pro (or any unlimited plan): always allowed, but still count for
  // accurate accounting in case the tenant later downgrades.
  if (limit === Infinity) {
    await Tenant.findByIdAndUpdate(tenantId, { $inc: { projectCount: 1 } });
    return { reserved: true, limit, plan: tenant.plan };
  }

  const updated = await Tenant.findOneAndUpdate(
    { _id: tenantId, projectCount: { $lt: limit } },
    { $inc: { projectCount: 1 } },
    { new: true }
  );

  if (updated) {
    return { reserved: true, limit, plan: tenant.plan };
  }

  // The conditional update matched nothing: the counter is already at the
  // limit. Exactly one concurrent request can win the update above, so we
  // reject without recounting (see the header for why a recount-and-retry
  // would be wrong here).
  return { reserved: false, limit, plan: tenant.plan };
}

/**
 * Gives a slot back when a project is archived or deleted (or when a create
 * failed after reserving). The $gt: 0 guard keeps the counter from going
 * negative if releases ever double-fire.
 */
export async function releaseProjectSlot(tenantId) {
  await Tenant.updateOne(
    { _id: tenantId, projectCount: { $gt: 0 } },
    { $inc: { projectCount: -1 } }
  );
}
