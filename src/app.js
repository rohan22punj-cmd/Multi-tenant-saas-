/**
 * Express application setup (no listening here — that's server.js).
 *
 * WHY separate app.js from server.js?
 * Tests import app.js to get the Express instance without starting
 * a real HTTP server. server.js imports app.js AND calls .listen().
 * This separation is a standard pattern for testable Express apps.
 *
 * MIDDLEWARE ORDER (top → bottom):
 * 1. requestId    — tag each request with a UUID before anything else
 * 2. helmet       — security headers
 * 3. cors         — cross-origin
 * 4. express.json — body parsing
 * 5. requestLogger — one log line per request (after finish)
 * 6. routes + rate limiters
 * 7. errorHandler — must be last
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import requestId from './middleware/requestId.js';
import requestLogger from './middleware/requestLogger.js';
import errorHandler from './utils/errorHandler.js';
import authRoutes from './routes/authRoutes.js';
import protect from './middleware/protect.js';
import tenantContextMiddleware from './middleware/tenantContext.js';
import { getTenantId } from './utils/tenantContext.js';
import { generalLimiter } from './middleware/rateLimiter.js';
import rbacDemoRoutes from './routes/rbacDemo.routes.js';
import userRoutes from './routes/userRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import taskRoutes from './routes/taskRoutes.js';
import activityRoutes from './routes/activityRoutes.js';

const app = express();

// ─── Request ID (must be first so all downstream middleware can use req.id) ───
app.use(requestId);

// ─── Security & parsing ───
// Serve OpenAPI docs ONLY in non-production OR when ENABLE_API_DOCS=true
const enableApiDocs = process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true';
if (enableApiDocs) {
  const specPath = path.resolve('src/docs/openapi.yaml');
  const spec = YAML.parse(fs.readFileSync(specPath, 'utf8'));
  // Relax helmet's script-src for Swagger UI inline scripts ONLY on /api/docs
  // swaggerUi.serve needs to handle both /api/docs and /api/docs/
  app.use('/api/docs', helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
      },
    },
  }), swaggerUi.serve);
  app.get('/api/docs', swaggerUi.setup(spec, { explorer: true }));
  app.get('/api/docs/', swaggerUi.setup(spec, { explorer: true }));
  app.get('/api/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(spec);
  });
}
// Apply helmet to all other routes (without the relaxed CSP)
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/docs')) {
    helmet()(req, res, next);
  } else {
    next();
  }
});
app.use(cors()); // allows cross-origin requests (configurable later)
app.use(express.json()); // parses JSON request bodies

// ─── Request logging (after parsing, before routes) ───
app.use(requestLogger);

// ─── Health check (no auth, no rate limit) ───
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
});

// ─── Rate limit all /api routes ───
app.use('/api', generalLimiter);

// ─── Auth routes (signup, login, refresh, logout) ───
app.use('/api/auth', authRoutes);

// ─── Demo RBAC routes (test-only, to delete later) ───
app.use('/api/demo', rbacDemoRoutes);

// ─── User management routes (deactivate / reactivate) ───
app.use('/api/users', userRoutes);

// ─── Project routes (all need protect + requirePermission) ───
app.use('/api/projects', projectRoutes);

// ─── Task routes (mounted at /api: covers /api/tasks/* and
//     /api/projects/:projectId/tasks) ───
app.use('/api', taskRoutes);

// ─── Activity feed (read-only, user:manage) ───
app.use('/api/activity', activityRoutes);

// ─── Protected test route ───
// Demonstrates that protect + tenantContext work together.
// In Phase 3+, all resource routes (projects, tasks) will use
// the same middleware chain.
app.get('/api/me', protect, tenantContextMiddleware, (req, res) => {
    // getTenantId() reads from AsyncLocalStorage, proving context works
    const contextTenantId = getTenantId();
    res.status(200).json({
        status: 'success',
        data: {
            userId: req.user.userId,
            tenantId: req.user.tenantId,
            contextTenantId,
            permissions: req.user.permissions,
        },
    });
});
// ─── Central error handler (must be LAST middleware) ───
app.use(errorHandler);

export default app;