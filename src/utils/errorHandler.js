/**
 * Central Express error-handling middleware.
 *
 * WHY: Instead of scattering try/catch with res.status() in every
 * controller, we let errors bubble up here. This single function
 * decides what the client sees. Operational errors (AppError) send
 * their message; unexpected errors send a generic "Internal Server
 * Error" so we never leak stack traces in production.
 *
 * REQUEST ID INCLUSION:
 * Every request has a unique ID (set by requestId middleware).
 * We include it in error responses so operators can correlate
 * client reports with server logs.
 */

import env from '../config/env.js';

const isProd = env.nodeEnv === 'production';

const errorHandler = (err, req, res, _next) => {
  const statusCode = err.statusCode || 500;
  const message = err.isOperational ? err.message : 'Internal Server Error';

  // Log error server-side (with stack in non-prod)
  if (!isProd) {
    console.error(`[ERROR] ${statusCode} — ${err.message}`);
    if (!err.isOperational) console.error(err.stack);
  } else if (!err.isOperational) {
    // In prod, log unexpected errors without stack to external logger
    console.error(`[ERROR] ${statusCode} — ${err.message} — reqId: ${req.id}`);
  }

  // Response shape
  const response = {
    status: 'error',
    statusCode,
    message,
    reqId: req.id,
  };

  res.status(statusCode).json(response);
};

export default errorHandler;
