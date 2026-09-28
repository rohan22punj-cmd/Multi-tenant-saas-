# Multi-Tenant SaaS Backend

A production-style multi-tenant SaaS backend with Role-Based Access Control (RBAC) and Stripe billing.

Multiple companies (tenants) share one server and database, but each company's data is completely invisible to every other company — enforced at the data layer, not by hoping every controller remembers to filter.

## Tech Stack

- **Runtime:** Node.js + Express (ES modules)
- **Database:** MongoDB (Mongoose) — shared database, tenant isolation via `tenantId` on every document
- **Cache:** Redis (ioredis) — webhook idempotency
- **Auth:** JWT (access + refresh tokens) with tenant and role embedded
- **Billing:** Stripe (test mode)
- **Tests:** Jest + Supertest
- **Containers:** Docker Compose

## Project Structure

```
src/
  config/        — database, redis, and environment config
  models/        — Mongoose schemas (Tenant, User, Role, Permission keys)
  middleware/    — auth, tenant context, permission checks (Phase 2+)
  controllers/  — thin request handlers (Phase 2+)
  services/     — business logic (Phase 2+)
  routes/       — Express route definitions (Phase 2+)
  utils/        — AppError, central error handler, async wrapper
  app.js        — Express app setup (no listening)
  server.js     — connects to DBs and starts listening
tests/           — Jest + Supertest test files
```

## Getting Started

### Prerequisites

- Node.js 20+
- Docker & Docker Compose (for MongoDB + Redis)

### Run locally (without Docker for the app)

```bash
# 1. Copy env file and edit as needed
cp .env.example .env

# 2. Start MongoDB + Redis via Docker
docker compose up mongo redis -d

# 3. Install dependencies
npm install

# 4. Start the server
npm run dev
```

### Run everything with Docker

```bash
cp .env.example .env
docker compose up --build
```

### Run tests

```bash
npm test
```

## Engineering Decisions

> This section will grow with each phase.

- **app.js / server.js split:** The Express app is defined in `app.js` without calling `.listen()`. Tests import `app.js` directly, so they never need a running server or database connections. `server.js` handles the "outside world" (DB connect, port binding).

- **Compound unique index on User `{ tenantId, email }`:** Email uniqueness is per-tenant, not global. Two different companies can each have a user with the same email — that's how real multi-tenant SaaS works.

- **Permissions as code constants:** Permission keys live in `src/models/permissions.js`, not in a database table. They map 1-to-1 to API capabilities, so you can `grep` the codebase for any key and find every place it's checked. Roles (in the DB) store arrays of these keys.

- **Central error handling:** A custom `AppError` class carries an HTTP status code. The central error handler decides what to expose to the client — operational errors show their message, unexpected errors get a generic "Internal Server Error" so stack traces never leak.

## Phases

- [x] Phase 1: Foundation (project setup, Docker, models)
- [ ] Phase 2: Auth + tenant context
- [ ] Phase 3: Enforced tenant isolation (Mongoose plugin)
- [ ] Phase 4: RBAC (roles, permissions, invite flow)
- [ ] Phase 5: Sample app (Projects + Tasks)
- [ ] Phase 6: Stripe billing + webhook idempotency
- [ ] Phase 7: Polish (full tests, Swagger, CI, architecture diagram)
