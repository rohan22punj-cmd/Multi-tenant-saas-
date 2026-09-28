/**
 * Entry point — connects to databases and starts listening.
 *
 * WHY this file exists separately from app.js:
 * app.js builds the Express app (routes, middleware), and this file
 * deals with "the outside world" (database connections, port binding).
 * Tests skip this file entirely and only import app.js.
 */

import app from './app.js';
import env from './config/env.js';
import connectDB from './config/db.js';
import { connectRedis } from './config/redis.js';

const start = async () => {
  try {
    await connectDB();
    await connectRedis();

    app.listen(env.port, () => {
      console.log(`Server running on port ${env.port} [${env.nodeEnv}]`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
};

start();
