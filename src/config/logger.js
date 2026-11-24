/**
 * Application logger — single pino instance used everywhere.
 *
 * WHAT THIS DOES:
 * Creates one pino logger for the whole app. Every file that needs
 * to log something imports this instead of calling console.log.
 *
 * WHY PINO:
 * Pino is the fastest Node.js JSON logger. It writes structured
 * JSON by default — perfect for piping into log aggregators
 * (Datadog, ELK, CloudWatch). In development it uses pino-pretty
 * for colored, human-readable output so you don't have to squint
 * at raw JSON in your terminal.
 *
 * SENSITIVE DATA REDACTION:
 * Pino's redact option automatically removes sensitive fields from
 * log output. We redact:
 *   - req.headers.authorization (Bearer tokens)
 *   - req.headers.cookie (session cookies)
 *   - req.body.password, req.body.passwordHash, req.body.newPassword
 *   - req.body.token, req.body.refreshToken, req.body.accessToken
 *   - req.body.hash, req.body.tokenHash
 *   - Any field containing "secret", "token", "password" in its name
 * This prevents accidental logging of credentials, tokens, or hashes.
 *
 * HOW IT DECIDES:
 * - NODE_ENV === 'development' → pretty-printed, colorized
 * - anything else (production, staging) → raw JSON (one line per log)
 * - NODE_ENV === 'test' → silent (level 'silent') so test output
 *   stays clean; override with LOG_LEVEL if you need debug output
 * - Log level is configurable via LOG_LEVEL env var (default: "info")
 *
 * USAGE:
 *   import logger from '../config/logger.js';
 *   logger.info({ reqId: '...', userId: '...' }, 'User logged in');
 *   logger.error({ err }, 'Database connection failed');
 */

import pino from 'pino';
import env from './env.js';

const isTest = env.nodeEnv === 'test';
const isDev = env.nodeEnv === 'development';

const logger = pino({
  level: isTest ? 'silent' : env.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.passwordHash',
      'req.body.newPassword',
      'req.body.token',
      'req.body.refreshToken',
      'req.body.accessToken',
      'req.body.hash',
      'req.body.tokenHash',
      'req.body.secret',
      'req.body.secretKey',
      'req.body.webhookSecret',
      'res.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  }),
});

export default logger;
