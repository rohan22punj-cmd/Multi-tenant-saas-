/**
 * Connects to MongoDB with Mongoose.
 * Exported as a function so the app can control WHEN the connection
 * happens (important for tests that use a different URI).
 */

import mongoose from 'mongoose';
import env from './env.js';

const connectDB = async () => {
  const conn = await mongoose.connect(env.mongodbUri);
  console.log(`MongoDB connected: ${conn.connection.host}`);
  return conn;
};

export default connectDB;
