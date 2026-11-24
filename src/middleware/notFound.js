/**
 * 404 handler for unknown routes.
 * Returns JSON 404 instead of HTML, with request ID for debugging.
 */

import AppError from '../utils/AppError.js';

export function notFoundHandler(req, _res, next) {
  throw new AppError('Route not found', 404);
}

export default notFoundHandler;