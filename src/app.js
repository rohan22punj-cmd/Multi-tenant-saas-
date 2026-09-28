/**
 * Express application setup (no listening here — that's server.js).
 *
 * WHY separate app.js from server.js?
 * Tests import app.js to get the Express instance without starting
 * a real HTTP server. server.js imports app.js AND calls .listen().
 * This separation is a standard pattern for testable Express apps.
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import errorHandler from './utils/errorHandler.js';

const app = express();

// ─── Security & parsing ───
app.use(helmet());           // sets security-related HTTP headers
app.use(cors());             // allows cross-origin requests (configurable later)
app.use(express.json());     // parses JSON request bodies

// ─── Health check ───
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ─── Central error handler (must be LAST middleware) ───
app.use(errorHandler);

export default app;
