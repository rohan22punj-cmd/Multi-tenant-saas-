/**
 * Loads environment variables and exports them with defaults.
 * Single source of truth — every part of the app imports config from here
 * instead of reading process.env directly. Makes typos and missing vars
 * easy to catch in one place.
 */

import dotenv from 'dotenv';
dotenv.config();

const env = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/multitenant',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    proPriceId: process.env.STRIPE_PRO_PRICE_ID,
  },
  logLevel: process.env.LOG_LEVEL || 'info',
  inviteExpiryDays: parseInt(process.env.INVITE_EXPIRY_DAYS, 10) || 7,
  passwordResetExpiryHours: parseInt(process.env.PASSWORD_RESET_EXPIRY_HOURS, 10) || 1,
  signupRateLimit: {
    windowMs: parseInt(process.env.SIGNUP_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.SIGNUP_RATE_LIMIT_MAX, 10) || 5,
  },
  loginRateLimit: {
    windowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 10,
  },
  // Body size limit for express.json (default 100kb)
  bodyLimit: process.env.BODY_LIMIT || '100kb',
  // CORS origins: comma-separated list (e.g. "https://app.example.com,https://admin.example.com")
  // In production, if empty, all cross-origin requests are blocked
  corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : [],
  // Number of proxies to trust (for rate limiting IP behind load balancers)
  // Set to 1 for Render, 2 for Cloudflare + Render, etc. Default 0 = no proxy trust
  trustProxy: parseInt(process.env.TRUST_PROXY, 10) || 0,
  // Fail mode for revocation when Redis is down
  revocationFailMode: (process.env.REVOCATION_FAIL_MODE || 'open').toLowerCase(),
};

export default env;
