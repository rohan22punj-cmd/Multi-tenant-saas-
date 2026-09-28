/**
 * Central Express error-handling middleware.
 *
 * WHY: Instead of scattering try/catch with res.status() in every
 * controller, we let errors bubble up here. This single function
 * decides what the client sees. Operational errors (AppError) send
 * their message; unexpected errors send a generic "Internal Server
 * Error" so we never leak stack traces in production.
 */

const errorHandler = (err, _req, res, _next) => {
  const statusCode = err.statusCode || 500;
  const message = err.isOperational ? err.message : 'Internal Server Error';

  if (process.env.NODE_ENV !== 'test') {
    console.error(`[ERROR] ${statusCode} — ${err.message}`);
    if (!err.isOperational) console.error(err.stack);
  }

  res.status(statusCode).json({
    status: 'error',
    statusCode,
    message,
  });
};

export default errorHandler;
