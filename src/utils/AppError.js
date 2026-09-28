/**
 * Custom error class used across the whole app.
 *
 * WHY: Express's default errors don't carry an HTTP status code.
 * By throwing `new AppError('Not found', 404)` anywhere in a service
 * or controller, the central error handler knows exactly what status
 * and message to send back. It also marks errors as "operational"
 * (expected, safe to show to the client) vs programming bugs.
 */

class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;          // safe to expose to client
    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;
