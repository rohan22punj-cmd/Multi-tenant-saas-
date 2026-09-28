/**
 * Wraps an async route handler so thrown errors automatically
 * reach the central error handler.
 *
 * WHY: Without this, every controller would need its own
 * try/catch block. With it, you just write:
 *   router.get('/things', asyncHandler(async (req, res) => { ... }));
 * and any rejected promise is forwarded to Express's next(err).
 */

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
