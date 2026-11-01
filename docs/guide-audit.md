# Guide Audit - What's Really Built vs What to Document

## Files That Actually Exist (BUILT)

### Core Infrastructure
- ✅ `src/config/db.js` - MongoDB connection
- ✅ `src/config/redis.js` - Redis connection  
- ✅ `src/config/env.js` - Environment config
- ✅ `src/config/logger.js` - Pino logger
- ✅ `src/utils/AppError.js` - Custom error class
- ✅ `src/utils/errorHandler.js` - Central error handler
- ✅ `src/utils/asyncHandler.js` - Async wrapper
- ✅ `src/server.js` - Server entry point
- ✅ `src/app.js` - Express app setup

### Auth & Security
- ✅ `src/middleware/protect.js` - JWT verification middleware
- ✅ `src/middleware/requirePermission.js` - Permission checks
- ✅ `src/middleware/rateLimiter.js` - Rate limiting (signup: 5/15min, login: 10/15min, general: 100/15min)
- ✅ `src/middleware/requestId.js` - Request ID generation
- ✅ `src/middleware/requestLogger.js` - Request logging
- ✅ `src/utils/tokens.js` - JWT signing/verification
- ✅ `src/services/authService.js` - Auth business logic
- ✅ `src/controllers/authController.js` - Auth HTTP handlers
- ✅ `src/routes/authRoutes.js` - Auth route mappings

### Multi-Tenancy
- ✅ `src/plugins/tenantPlugin.js` - Mongoose plugin for automatic tenant scoping
- ✅ `src/utils/tenantContext.js` - AsyncLocalStorage for tenant context
- ✅ `src/middleware/tenantContext.js` - Tenant context middleware

### Models
- ✅ `src/models/Tenant.js` - Tenant model (NO tenantId field, NO plugin applied)
- ✅ `src/models/User.js` - User model (HAS plugin)
- ✅ `src/models/Role.js` - Role model (HAS plugin)
- ✅ `src/models/Invite.js` - Invite model (HAS plugin)
- ✅ `src/constants/permissions.js` - Permission constants
- ✅ `src/models/permissions.js` - Permission utilities

### User Management
- ✅ `src/controllers/userController.js` - Deactivate/reactivate
- ✅ `src/routes/userRoutes.js` - User management routes

### Tests
- ✅ `tests/health.test.js`
- ✅ `tests/signupRateLimit.test.js`
- ✅ `tests/loginRateLimit.test.js`
- ✅ `tests/refreshLogout.test.js`
- ✅ `tests/authMiddleware.test.js`
- ✅ `tests/auth.test.js`
- ✅ `tests/tenantIsolation.test.js`
- ✅ `tests/rbac.test.js`
- ✅ `tests/userDeactivate.test.js`

## What's NOT Built (PLANNED)

### Missing Features
- ❌ Projects model
- ❌ Tasks model
- ❌ Stripe webhook handler
- ❌ Plan limits enforcement
- ❌ Activity log
- ❌ Swagger/OpenAPI docs
- ❌ GitHub Actions CI
- ❌ Role changing endpoint
- ❌ Frontend (React)

## Key Facts from Real Code

### Signup Flow (authService.js lines 146-210)
- **NOT atomic** - No MongoDB transaction used
- Uses runUnscoped for Tenant operations (Tenant has NO tenantId field)
- Uses runWithTenant for Role/User creation
- Bcrypt rounds: 12 (line 57)
- Explicitly stamps tenantId on Roles (lines 179, 184) 
- Does NOT rely on plugin for Role creation

### Login Flow (authService.js lines 221-273)
- Requires: companySlug, email, password
- Timing attack protection: DUMMY_HASH (line 61), always runs bcrypt.compare (line 242)
- Returns same "Invalid credentials" for all failures (line 247)

### Token Details (from env.js and utils/tokens.js)
- Access token expiry: '15m' (default)
- Refresh token expiry: '7d' (default)
- Access payload: userId, tenantId, roleId, permissions
- Refresh payload: userId, tenantId, jti (random UUID)
- Hash: SHA-256 for refresh tokens

### Rate Limits (rateLimiter.js)
- Signup: 5 requests per 15 minutes per IP
- Login: 10 requests per 15 minutes per IP  
- General API: 100 requests per 15 minutes per IP
- Skipped in test mode (NODE_ENV=test)

### Plugin Behavior (tenantPlugin.js)
- Adds tenantId field if not present (line 132-141)
- Hooks: find, findOne, findOneAndUpdate, findOneAndDelete, findOneAndReplace, updateOne, updateMany, replaceOne, deleteOne, deleteMany, countDocuments, distinct (lines 40-53)
- Aggregate: injects $match at position 0, throws on $geoNear (lines 105-126)
- Save hook: stamps tenantId on new docs, blocks changes on existing (lines 198-220)
- Blocks: estimatedDocumentCount (lines 172-180), bulkWrite (lines 250-259)
- Does NOT hook create() or insertMany() - relies on save() hook

### Permissions (constants/permissions.js)
- Admin gets: ALL_PERMISSIONS (all 12 permissions)
- Member gets: PROJECT_READ, TASK_CREATE, TASK_READ, TASK_UPDATE (4 permissions)
- Total permissions: 12 (project:4, task:4, user:2, billing:2)

### runUnscoped Usage (grep results)
- Used in: authService.js (signup, login, refresh, logout)
- Used in: tests/tenantIsolation.test.js
- Purpose: Query Tenant model (which has NO plugin, so technically doesn't need it, but used for consistency and logging)

### Deactivation (userController.js)
- Sets isActive = false
- Clears refreshTokenHash
- Guards: self-deactivation (403), last admin (409), privilege escalation (403)
- Access token remains valid for up to 15 minutes (comment line 26)

## Critical Corrections Needed

### 1. Signup NOT Atomic
**Wrong claim**: "Signup is one atomic operation with rollback"
**Reality**: No transaction. If crash after Tenant create, orphaned tenant exists.
**Fix needed**: Document the actual behavior, explain MongoDB transaction would need replica set, mention unique index on slug for race protection

### 2. Tenant Queries & runUnscoped
**Wrong claim**: "Tenant queries need runUnscoped because plugin is applied"
**Reality**: Tenant model does NOT have plugin applied (Tenant.js line 44, no plugin call)
**Fix needed**: Explain runUnscoped is used in authService for logging/consistency, but technically unnecessary for Tenant

### 3. Stripe Idempotency (NOT BUILT)
**Wrong claim**: Claims Redis key prevents duplicate processing
**Reality**: NO Stripe code exists in repo
**Fix needed**: Mark entire section PLANNED, fix the crash scenario logic when documenting the plan

### 4. Plugin Hooks on Create
**Reality**: Plugin does NOT hook create() or insertMany() directly (see tenantPlugin.js line 222-223)
**Fix needed**: Document that create() goes through save() hook, insertMany requires explicit tenantId

### 5. Token Expiry Values
**Must verify**: Use actual values from env.js (15m, 7d defaults)

### 6. Rate Limit Numbers
**Must verify**: Use actual values from rateLimiter.js and env.js

## Real Bugs/Gaps Found

### Security Gaps
1. **Signup race condition**: Two simultaneous signups with same name could both pass duplicate check. Unique index helps but error handling could be better.
2. **No email verification**: Signup doesn't verify email ownership
3. **Deactivated user grace period**: 15-minute window where access token still works
4. **No Redis blocklist**: Can't instantly revoke access tokens

### Code Quality
1. **Signup not atomic**: Crash leaves orphaned tenant
2. **No unique index error handling**: 11000 error not caught and converted to friendly message

## Files to Create

1. `docs/interview-guide.html` - Complete guide with all sections
2. Navigation must match all sections (no broken links)
3. Every code example must come from real files
4. Every "BUILT" feature labeled clearly
5. Every "PLANNED" feature labeled clearly
