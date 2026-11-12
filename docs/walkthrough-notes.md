# Build Status Notes (source-of-truth snapshot)

Verified by reading every file under `src/` and `tests/`. Nothing here is guessed.

## BUILT (working code, tested)

| Area | Files | Proved by |
|---|---|---|
| App entry & config | `src/server.js`, `src/app.js`, `src/config/env.js`, `src/config/db.js`, `src/config/redis.js`, `src/config/logger.js`, `src/config/plans.js` | `tests/health.test.js` |
| Error handling | `src/utils/AppError.js`, `src/utils/errorHandler.js`, `src/utils/asyncHandler.js` | all suites |
| Tenant context | `src/utils/tenantContext.js` (AsyncLocalStorage, runWithTenant, getTenantId, runUnscoped) | `tests/tenantIsolation.test.js` |
| Auth middleware | `src/middleware/protect.js`, `src/middleware/tenantContext.js`, `src/middleware/rateLimiter.js`, `src/middleware/requestId.js`, `src/middleware/requestLogger.js` | `tests/authMiddleware.test.js` |
| Permission middleware | `src/middleware/requirePermission.js` | `tests/rbac.test.js` |
| Permission constants | `src/constants/permissions.js` | `tests/rbac.test.js` |
| Mongoose models | `src/models/Tenant.js`, `User.js`, `Role.js`, `Invite.js`, `Project.js`, `Task.js`, `ActivityLog.js`, `permissions.js` | all suites |
| Tenant plugin | `src/plugins/tenantPlugin.js` | `tests/tenantIsolation.test.js` |
| Signup | `src/services/authService.js` (signup), `src/controllers/authController.js` | `tests/auth.test.js` |
| Login | `src/services/authService.js` (login), `src/controllers/authController.js` | `tests/auth.test.js` |
| Refresh / logout | `src/services/authService.js` (refresh, logout) | `tests/refreshLogout.test.js` |
| Invite + accept-invite | `src/controllers/authController.js` (invite, acceptInvite) | `tests/rbac.test.js` |
| Deactivate / reactivate / change role | `src/controllers/userController.js` | `tests/userDeactivate.test.js`, `tests/changeRole.test.js` |
| Projects | `src/controllers/projectController.js`, `src/services/projectService.js`, `src/services/planService.js` | `tests/projects.test.js`, `tests/planLimit.test.js` |
| Tasks | `src/controllers/taskController.js`, `src/services/taskService.js` | `tests/tasks.test.js` |
| Activity log | `src/controllers/activityController.js`, `src/services/activityService.js` | `tests/activity.test.js` |
| Rate limits | `src/middleware/rateLimiter.js` | `tests/loginRateLimit.test.js`, `tests/signupRateLimit.test.js` |
| Docker | `docker-compose.yml`, `Dockerfile` | manual |
| Structured logging | `src/config/logger.js`, `src/middleware/requestLogger.js`, `src/middleware/requestId.js` | `tests/health.test.js` |

## PARTIAL / NOT BUILT

| Area | Status | What is missing |
|---|---|---|
| Stripe billing fields on Tenant | NOT BUILT | No `stripeCustomerId`, `stripeSubscriptionId`, `subscriptionStatus`, `currentPeriodEnd` on the schema |
| `src/services/stripe.service.js` | NOT BUILT | The SDK wrapper file does not exist |
| Billing routes (`/api/billing/*`) | NOT BUILT | No `src/routes/billingRoutes.js`, no controller |
| Stripe webhook (`POST /api/webhooks/stripe`) | NOT BUILT | No raw-body route, no signature check, no event handlers |
| Redis idempotency claim | NOT BUILT | No `SET key NX EX` claim logic |
| `StripeEvent` model + unique index | NOT BUILT | No model, no unique index on `eventId` |
| Out-of-order event handling | NOT BUILT | No `lastStripeEventAt` on Tenant |
| `.env.example` Stripe fields | PARTIAL | Has `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` only. Missing `STRIPE_PRO_PRICE_ID` and `APP_URL` |
| `ioredis-mock` dependency | NOT BUILT | Not in `package.json` (webhook tests need it) |
| `npm audit` | NOT RUN | Could not run in this session |

## PLANNED (explicitly deferred)

- Frontend, email, custom roles beyond admin/member, forgot-password, token revocation list, Swagger/OpenAPI, CI pipeline, architecture diagram docs.