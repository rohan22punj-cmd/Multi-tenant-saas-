/**
 * Creates and exports a Redis client (ioredis).
 * Used for webhook idempotency in Phase 6. Set up now so Docker
 * Compose can verify the connection early.
 */

import Redis from 'ioredis';
import env from './env.js';

let redis = null;

export const connectRedis = () => {
  redis = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,          // don't connect until we call .connect()
  });

  redis.on('connect', () => console.log('Redis connected'));
  redis.on('error', (err) => console.error('Redis error:', err.message));

  return redis.connect().then(() => redis);
};

export const getRedis = () => redis;

export default redis;
