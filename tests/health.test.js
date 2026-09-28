/**
 * Smoke test — proves the Express app boots and the health
 * endpoint responds correctly.
 *
 * This test does NOT connect to MongoDB or Redis because it
 * only imports app.js (which sets up routes and middleware)
 * and never calls server.js (which connects to databases).
 */

import request from 'supertest';
import app from '../src/app.js';

describe('GET /health', () => {
  it('should return 200 with status ok', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
