# User Deactivation & Reactivation Feature

## What Was Built

Two new endpoints for managing user active status:

1. **PATCH /api/users/:id/deactivate** — Deactivates a user
2. **PATCH /api/users/:id/reactivate** — Reactivates a user

Both routes require:
- Valid JWT access token (`protect` middleware)
- `user:manage` permission (`requirePermission` middleware)
- Valid MongoDB ObjectId for `:id` param (validated before controller)

## Files Created/Modified

### Created:
- `src/controllers/userController.js` — Deactivate & reactivate handlers
- `src/routes/userRoutes.js` — User management routes
- `tests/userDeactivate.test.js` — Full test suite (13 tests)

### Modified:
- `src/app.js` — Wired `/api/users` routes
- `src/routes/rbacDemo.routes.js` — Added GET `/api/demo/roles` for tests
- `src/services/authService.js` — Explicitly stamped `tenantId` on Role.create()

## Plain-English Explanations

### Why We Wipe the Refresh Token on Deactivation

When you deactivate a user, we set `isActive = false` AND clear their `refreshTokenHash`. Here's why:

**The access token is stateless** — we do NOT check the database on every request. That would destroy performance. A deactivated user's access token stays valid for up to 15 minutes until it expires naturally. That's an accepted trade-off for speed.

**But we CAN cut off their NEXT session immediately** — by clearing `refreshTokenHash`, the user cannot exchange their refresh token for a new access token. So worst case: a deactivated user has 15 minutes of residual access, then they're locked out.

**If you need instant cutoff**, add a token revocation list (e.g., Redis blocklist that `protect.js` checks on every request). That's a heavier solution we skipped for Phase 2.

---

### Why the Last-Admin Rule Exists

**The problem**: If an admin deactivates the only other admin, no one with `user:manage` can reactivate anyone. The company is effectively locked out.

**The solution**: We refuse to deactivate the last active user whose role has the `user:manage` permission. The check:
1. Find all roles in this tenant that have `user:manage`
2. Count active users (excluding the one we're about to deactivate) with one of those roles
3. If the count is 0 AND the target user has an admin role → return 409 "Cannot deactivate the last admin"

**Why count by permission, not by role name?** Custom roles can have `user:manage` too. We never hard-code role names in business logic — that's the whole point of RBAC.

---

## Business Rules

### Deactivation Guards

**a) Cannot deactivate yourself** (403 Forbidden)
- Prevents self-lockout

**b) Cannot deactivate the last active admin** (409 Conflict)
- Ensures the company always has someone who can manage users

**c) Cannot deactivate someone with more permissions than you** (403 Forbidden)
- Privilege rule: you must have ALL the permissions the target's role has
- Stops a low-power user from sidelining a higher-power one

**d) Tenant isolation** (404 Not Found)
- Company A's admin using a user ID from Company B gets 404
- The `tenantPlugin` automatically scopes the query
- Company B's user stays active

### Reactivation

- Sets `isActive = true`
- Idempotent — already-active users return 200
- Same 404 tenant isolation rule

---

## Curl Commands

### 1. Deactivate a User

```bash
curl -X PATCH http://localhost:3000/api/users/6745a1b2c3d4e5f6a7b8c9d0/deactivate \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json"
```

**Success (200)**:
```json
{
  "id": "6745a1b2c3d4e5f6a7b8c9d0",
  "isActive": false
}
```

**Errors**:
- `400` — Invalid ObjectId format
- `401` — Missing or invalid token
- `403` — Self-deactivation, or insufficient permissions, or target has more permissions
- `404` — User not found (or belongs to another tenant)
- `409` — Last admin

---

### 2. Reactivate a User

```bash
curl -X PATCH http://localhost:3000/api/users/6745a1b2c3d4e5f6a7b8c9d0/reactivate \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json"
```

**Success (200)**:
```json
{
  "id": "6745a1b2c3d4e5f6a7b8c9d0",
  "isActive": true
}
```

**Errors**:
- `400` — Invalid ObjectId format
- `401` — Missing or invalid token
- `403` — No `user:manage` permission
- `404` — User not found

---

## Running Tests

### Run Just the New Test File

```bash
npm test -- tests/userDeactivate.test.js
```

Or with full environment setup:

```bash
cross-env NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules jest tests/userDeactivate.test.js --forceExit --detectOpenHandles
```

### Test Coverage (13 tests)

1. ✓ Admin deactivates a member → member cannot log in
2. ✓ Old refresh token returns 401 after deactivation
3. ✓ Reactivation lets the member log in again
4. ✓ Member without USER_MANAGE gets 403
5. ✓ No token → 401
6. ✓ Deactivating yourself → 403
7. ✓ Deactivating the sole admin → 409
8. ✓ Two admins → one can deactivate the other
9. ✓ Cannot deactivate user with more permissions → 403
10. ✓ Cross-tenant: Company A admin using Company B user id → 404, B's user stays active
11. ✓ Invalid ObjectId → 400
12. ✓ Deactivating twice returns 200 both times (idempotent)
13. ✓ GET /health still works (regression check)

### Run All Tests

```bash
npm test
```

---

## Implementation Notes

### Trade-Offs Documented in Code

1. **Access tokens remain valid for up to 15 minutes post-deactivation**
   - Location: `userController.js` comment at top
   - Ponytail marker: Points to revocation list as upgrade path

2. **Explicit tenantId Stamping**
   - Location: `authService.js` line 174-186
   - Why: Mongoose 9's `Model.create()` doesn't reliably trigger `pre('save')` hooks
   - Fix: Pass `tenantId: tenant._id` explicitly in the document

### Validation

- ObjectId validation happens in middleware before the controller
- Saves a pointless DB round-trip for malformed IDs
- Returns `400 "Invalid user id"` immediately

### Security

- `tenantId` ONLY ever comes from the JWT (via `req.user.tenantId`)
- Never from `req.params`, `req.body`, or `req.query`
- The `tenantPlugin` enforces this at the database level

---

## What Was NOT Built (Per Instructions)

- Role changing
- Projects
- Tasks
- Stripe billing

The feature is complete and focused only on deactivate/reactivate.
