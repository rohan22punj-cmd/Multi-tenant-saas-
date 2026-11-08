/**
 * Plan definitions — the single place that decides what each billing plan allows.
 *
 * WHY A CONFIG FILE:
 * Limits are business rules, not database facts. Keeping them here means
 * changing Free from 3 to 5 projects is a one-line code change, and the
 * services never hard-code a number. The *plan a tenant is on* still comes
 * from the Tenant document in MongoDB — never from the JWT — so a Stripe
 * webhook that upgrades a company takes effect immediately, even if the
 * user's existing access token still says "free".
 *
 * Infinity means "no limit" for that plan.
 */

export const PLANS = Object.freeze({
  free: Object.freeze({
    maxProjects: 3,
  }),
  pro: Object.freeze({
    maxProjects: Infinity,
  }),
});

/**
 * Returns the limits for a plan name.
 * Unknown plan names fall back to Free limits (fail closed, never unlimited).
 */
export function getPlanLimits(plan) {
  return PLANS[plan] || PLANS.free;
}

export default PLANS;
