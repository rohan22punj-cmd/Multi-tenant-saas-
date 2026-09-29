/**
 * Express application setup (no listening here — that's server.js).
 *
 * WHY separate app.js from server.js?
 * Tests import app.js to get the Express instance without starting
 * a real HTTP server. server.js imports app.js AND calls .listen().
 * This separation is a standard pattern for testable Express apps.
 *
 * PHASE 2 ADDITIONS:
 * - Auth routes mounted at /api/auth
 * - A protected /api/me endpoint for testing auth middleware
 * - General rate limiter on all /api routes
 * - Tenant context middleware on protected routes
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import errorHandler from './utils/errorHandler.js';
import authRoutes from './routes/authRoutes.js';
import protect from './middleware/protect.js';
import tenantContextMiddleware from './middleware/tenantContext.js';
import { generalLimiter } from './middleware/rateLimiter.js';

const app = express();

// ─── Security & parsing ───
app.use(helmet());           // sets security-related HTTP headers
app.use(cors());             // allows cross-origin requests (configurable later)
app.use(express.json());     // parses JSON request bodies

// ─── Health check (no auth, no rate limit) ───
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ─── Rate limit all /api routes ───
app.use('/api', generalLimiter);

// ─── Auth routes (signup, login, refresh, logout) ───
app.use('/api/auth', authRoutes);

// ─── Protected test route ───
// Demonstrates that protect + tenantContext work together.
// In Phase 3+, all resource routes (projects, tasks) will use
// the same middleware chain.
app.get('/api/me', protect, tenantContextMiddleware, (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      userId: req.user.userId,
      tenantId: req.user.tenantId,
      permissions: req.user.permissions,
    },
  });
});

// ─── Central error handler (must be LAST middleware) ───
app.use(errorHandler);

export default app;
