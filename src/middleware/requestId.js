/**
 * Request-ID middleware — tags every request with a unique ID.
 *
 * WHAT THIS DOES:
 * Attaches a UUID to req.id and echoes it back in the X-Request-Id
 * response header. If the client already sent an X-Request-Id header,
 * we reuse it — this lets an API gateway or frontend pass a trace ID
 * through the whole service chain.
 *
 * WHY THIS MATTERS:
 * When a user reports "something went wrong", you ask for the request
 * ID. One grep across your logs finds the exact request, what it did,
 * and where it failed. Without it, you're guessing from timestamps.
 *
 * WHY crypto.randomUUID():
 * Built into Node 19+ (and 16.7+ behind a flag). No extra package
 * needed. Produces a standard v4 UUID — good enough for request
 * tracing (we're not using it for security, just correlation).
 */

import crypto from 'node:crypto';

export default function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
