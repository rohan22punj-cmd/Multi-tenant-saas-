/**
 * Request logger middleware — logs one structured line per request.
 *
 * WHAT THIS DOES:
 * Hooks into res.on('finish') so it logs AFTER the response is sent.
 * Each log line includes: method, path, status code, response time
 * in milliseconds, and the request ID (set by requestId middleware).
 *
 * WHY AFTER 'finish' AND NOT BEFORE:
 * We need the final status code and the response time. Both are only
 * known after the response is written. The 'finish' event fires when
 * the last byte is handed to the OS — the earliest moment we have
 * all the data.
 *
 * WHAT ABOUT SENSITIVE DATA:
 * This middleware logs the URL path and query string, NOT the request
 * body. Passwords, tokens, and other secrets live in the body — they
 * never appear in the log. The signup controller receives { password }
 * in req.body, but this logger never touches req.body, so passwords
 * and password hashes are never logged. If you ever add query-param
 * auth (don't), you'd need to redact here.
 */

import logger from '../config/logger.js';

export default function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    const line = {
      reqId: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms,
    };

    if (res.statusCode >= 500) {
      logger.error(line, 'request');
    } else if (res.statusCode >= 400) {
      logger.warn(line, 'request');
    } else {
      logger.info(line, 'request');
    }
  });

  next();
}
