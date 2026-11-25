/**
 * Express application setup (no listening here — that's server.js).
 *
 * WHY separate app.js from server.js?
 * Tests import app.js to get the Express instance without starting
 * a real HTTP server. server.js imports app.js AND calls .listen().
 * This separation is a standard pattern for testable Express apps.
 *
 * MIDDLEWARE ORDER (top → bottom):
 * 1. trust proxy     — trust X-Forwarded-For for correct IP behind proxies
 * 2. requestId       — tag each request with a UUID before anything else
 * 3. helmet          — security headers (CSP, X-Powered-By removed, etc.)
 * 4. cors            — strict allowlist from CORS_ORIGINS
 * 5. express.json    — body parsing with size limit (BODY_LIMIT)
 * 6. noSqlInjection  — reject MongoDB operator keys ($, .) in body/query/params
 * 7. requestLogger   — one log line per request (after finish)
 * 8. routes + rate limiters
 * 9. notFound        — JSON 404 for unknown routes
 * 10. errorHandler   — must be last
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
import noSqlInjectionProtection from './middleware/security.js';
import notFoundHandler from './middleware/notFound.js';
import authRoutes from './routes/authRoutes.js';
import billingRoutes from './routes/billingRoutes.js';
import protect from './middleware/protect.js';
import tenantContextMiddleware from './middleware/tenantContext.js';
import { getTenantId } from './utils/tenantContext.js';
import { generalLimiter } from './middleware/rateLimiter.js';
import rbacDemoRoutes from './routes/rbacDemo.routes.js';
import userRoutes from './routes/userRoutes.js';
import projectRoutes from './routes/projectRoutes.js';
import taskRoutes from './routes/taskRoutes.js';
import activityRoutes from './routes/activityRoutes.js';
import env from './config/env.js';

const app = express();

// ─── Trust Proxy (must be first for correct req.ip behind proxies) ───
// TRUST_PROXY=0 (default): no proxy, req.ip is socket address
// TRUST_PROXY=1: one proxy (Render, Heroku), trust first X-Forwarded-For
// TRUST_PROXY=2: two proxies (Cloudflare + Render), trust second-to-last
// REQUIRED for correct rate limiting IP behind any load balancer/CDN.
app.set('trust proxy', env.trustProxy);

// ─── Request ID (must be early so all downstream middleware can use req.id) ───
app.use(requestId);

// ─── Helmet: security headers (CSP, X-Powered-By removed, HSTS, etc.) ───
// OpenAPI docs exception handled below; API gets strict CSP (no inline scripts/styles)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'font-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // allow swagger-ui to load
  crossOriginResourcePolicy: { policy: 'same-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, // 1 year
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  xssFilter: true,
}));

// Remove X-Powered-By header completely
app.use((_req, res, next) => {
  res.removeHeader('X-Powered-By');
  next();
});

// ─── CORS: strict allowlist from CORS_ORIGINS ───
// In production, if CORS_ORIGINS is empty, block all cross-origin requests.
// In development, allow all if not explicitly set.
const isProduction = process.env.NODE_ENV === 'production';
const corsOrigins = env.corsOrigins;

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (no origin header) like curl, mobile apps
    if (!origin) return callback(null, true);
    if (!isProduction && corsOrigins.length === 0) {
      // Development: allow all if not explicitly configured
      return callback(null, true);
    }
    if (corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS: Origin not allowed'));
  },
  credentials: false, // we use Bearer tokens, not cookies
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400, // 24 hours
};
app.use(cors(corsOptions));

// ─── Body Parsing with Size Limit ───
// BODY_LIMIT from env (default 100kb). Returns 413 with clean error shape.
app.use(express.json({ limit: env.bodyLimit }));

// ─── NoSQL Injection Protection ───
// Rejects any request with $ or . in keys (body, query, params)
// Must run AFTER body parsing but BEFORE routes
app.use(noSqlInjectionProtection);

// ─── Request Logging (after parsing, before routes) ───
app.use(requestLogger);

// ─── Health Check (no auth, no rate limit) ───
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
});

// ─── Rate Limit all /api routes ───
app.use('/api', generalLimiter);

import billingRoutes from './routes/billingRoutes.js';

// ─── Auth Routes (signup, login, refresh, logout) ───
// Add Cache-Control: no-store for auth responses
app.use('/api/auth', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
}, authRoutes);

import webhookController from './controllers/webhookController.js';

// ─── Stripe Webhook Route — raw body parser with own limit
// This MUST come BEFORE express.json so the raw body is available
// for signature verification. express.raw() parses the raw body
// without consuming it, so express.json() can still parse for
// other routes. Comment: this is the ONLY route that needs raw body.
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), webhookController.handleStripeWebhook);

// ─── Billing Routes (Pro upgrade, portal, status) ───
// Add Cache-Control: no-store for billing responses
app.use('/api/billing', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
}, billingRoutes);

// ─── Demo RBAC Routes (test-only, to delete later) ───
app.use('/api/demo', rbacDemoRoutes);

// ─── User Management Routes (deactivate / reactivate) ───
app.use('/api/users', userRoutes);

// ─── Project Routes (all need protect + requirePermission) ───
app.use('/api/projects', projectRoutes);

// ─── Task Routes (mounted at /api) ───
app.use('/api', taskRoutes);

// ─── Activity Feed (read-only, user:manage) ───
app.use('/api/activity', activityRoutes);

// ─── Protected Test Route ───
app.get('/api/me', protect, tenantContextMiddleware, (req, res) => {
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

// ─── Swagger UI (relaxed CSP only for /api/docs) ───
const enableApiDocs = process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true';
if (enableApiDocs) {
  const specPath = path.resolve('src/docs/openapi.yaml');
  const spec = YAML.parse(fs.readFileSync(specPath, 'utf8'));
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

// ─── Cache-Control: no-store on billing responses ───
app.use('/api/billing', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ─── 404 Handler (must be before errorHandler) ───
app.use(notFoundHandler);

// ─── Central Error Handler (must be LAST middleware) ───
app.use(errorHandler);

export default app;