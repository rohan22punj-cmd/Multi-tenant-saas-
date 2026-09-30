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
  },
  signupRateLimit: {
    windowMs: parseInt(process.env.SIGNUP_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.SIGNUP_RATE_LIMIT_MAX, 10) || 5,
  },
};

export default env;
