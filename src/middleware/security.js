/**
 * Security middleware — protects against NoSQL injection and malformed input.
 *
 * WHAT THIS DOES:
 * 1. Rejects any request where body, query, or params contain keys starting with "$"
 *    or containing "." — these are MongoDB operator keys that could be used for
 *    injection (e.g., { "email": { "$gt": "" } } or { "status.$ne": "done" }).
 * 2. Returns 400 with a generic message — we reject rather than sanitize because
 *    silent rewriting hides bugs and attackers can probe what was filtered.
 *
 * WHY REJECT INSTEAD OF CLEAN:
 * - "Cleaning" (silently removing $ keys) hides bugs: a developer might think
 *   their validation works, but the middleware silently changed the input.
 * - Attackers can probe what gets filtered vs what passes, learning about the
 *   internal schema.
 * - Explicit rejection fails fast and loud, making the problem visible at the
 *   exact request that caused it.
 *
 * NO-SQL INJECTION EXPLAINED:
 * MongoDB uses special operators prefixed with "$" (e.g., $gt, $ne, $regex)
 * to modify queries. If an attacker sends { "email": { "$gt": "" } } instead
 * of a string, and the code does User.findOne({ email: req.body.email }),
 * MongoDB interprets it as "find all users where email > ''" — returning
 * ALL users instead of just one. This is NoSQL injection.
 *
 * WHY ALSO CHECK FOR "." IN KEYS:
 * MongoDB uses dot notation for nested fields (e.g., "address.city").
 * An attacker could send { "address.city": { "$gt": "" } } to inject into
 * nested queries. Blocking "." in keys prevents this vector.
 *
 * QUERY STRING PROTECTION:
 * Express's default query parser (extended) allows nested objects via
 * brackets: ?status[$ne]=done becomes { status: { $ne: 'done' } }.
 * This middleware checks req.query AFTER parsing, so it catches these too.
 */

import AppError from '../utils/AppError.js';

/**
 * Recursively checks an object for forbidden keys.
 * Throws AppError(400) if any key starts with "$" or contains ".".
 */
function checkForInjection(obj, path = '') {
  if (!obj || typeof obj !== 'object') return;

  // Handle arrays
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      checkForInjection(obj[i], `${path}[${i}]`);
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    // Check for MongoDB operator keys (starting with $)
    if (key.startsWith('$')) {
      throw new AppError('Invalid input', 400);
    }
    // Check for dot notation (nested field access)
    if (key.includes('.')) {
      throw new AppError('Invalid input', 400);
    }
    // Recurse into nested objects
    const value = obj[key];
    if (value && typeof value === 'object') {
      checkForInjection(value, `${path}.${key}`);
    }
  }
}

/**
 * Middleware that checks body, query, and params for NoSQL injection attempts.
 * Runs early, before any route handlers.
 */
export function noSqlInjectionProtection(req, _res, next) {
  try {
    // Check body (JSON parsed by express.json)
    if (req.body && typeof req.body === 'object') {
      checkForInjection(req.body, 'body');
    }

    // Check query params (parsed by express)
    if (req.query && typeof req.query === 'object') {
      checkForInjection(req.query, 'query');
    }

    // Check route params
    if (req.params && typeof req.params === 'object') {
      checkForInjection(req.params, 'params');
    }

    next();
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    // Unexpected error — treat as invalid input
    throw new AppError('Invalid input', 400);
  }
}

export default noSqlInjectionProtection;