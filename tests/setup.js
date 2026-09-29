/**
 * Shared test setup — in-memory MongoDB for fast, isolated tests.
 *
 * WHAT THIS DOES:
 * Uses mongodb-memory-server to spin up a disposable MongoDB instance
 * that runs entirely in RAM. Each test file gets a clean database.
 *
 * WHY IN-MEMORY INSTEAD OF A REAL DATABASE:
 * - Tests run in CI without needing Docker or a Mongo install
 * - Each test suite starts fresh — no leftover data from other tests
 * - Fast: in-memory is ~10x faster than disk-backed Mongo
 *
 * HOW TO USE:
 * Import { connectTestDB, closeTestDB, clearTestDB } in your test
 * file. Call connectTestDB() in beforeAll, clearTestDB() in
 * beforeEach (optional), and closeTestDB() in afterAll.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer;

/**
 * Starts an in-memory MongoDB and connects Mongoose to it.
 * Call this in beforeAll().
 */
export async function connectTestDB() {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
}

/**
 * Drops all collections — gives each test a clean slate.
 * Call this in beforeEach() if tests need isolation.
 */
export async function clearTestDB() {
  const collections = await mongoose.connection.db.collections();
  for (const collection of collections) {
    await collection.deleteMany({});
  }
}

/**
 * Disconnects Mongoose and stops the in-memory server.
 * Call this in afterAll().
 */
export async function closeTestDB() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
}
