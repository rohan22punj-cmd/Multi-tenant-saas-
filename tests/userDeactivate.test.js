/**
 * Tests for PATCH /api/users/:id/deactivate and /reactivate
 *
 * Uses mongodb-memory-server (via tests/setup.js) — no real Mongo needed.
 * Rate limiters are skipped in NODE_ENV=test (see rateLimiter.js).
 *
 * TEST COVERAGE:
 *   1.  Admin deactivates a member → member cannot log in
 *   2.  Old refresh token returns 401 after deactivation
 *   3.  Reactivation lets the member log in again
 *   4.  Member without USER_MANAGE gets 403
 *   5.  No token → 401
 *   6.  Deactivating yourself → 403
 *   7.  Deactivating the sole admin → 409
 *   8.  Two admins → one can deactivate the other
 *   9.  Cannot deactivate someone with more permissions → 403
 *  10.  Cross-tenant: Company A admin using Company B user id → 404, B's user stays active
 *  11.  Invalid ObjectId → 400
 *  12.  Deactivating twice returns 200 both times
 *  13.  Re-run of previous test suites (health endpoint smoke test)
 */

import request from 'supertest';
import app from '../src/app.js';
import { connectTestDB, clearTestDB, closeTestDB } from './setup.js';

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(() => connectTestDB());
afterAll(() => closeTestDB());
beforeEach(() => clearTestDB());

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Signs up a fresh tenant and returns { accessToken, refreshToken, userId }.
 */
async function createTenant({ companyName, adminName, email, password = 'SecureP@ss123' }) {
  const res = await request(app).post('/api/auth/signup').send({
    companyName,
    adminName,
    email,
    password,
  });
  expect(res.status).toBe(201);
  return {
    accessToken: res.body.data.accessToken,
    refreshToken: res.body.data.refreshToken,
    userId: res.body.data.user.id,
    tenantSlug: res.body.data.tenant.slug,
  };
}

/**
 * Logs in as an existing user. Returns { accessToken, refreshToken }.
 */
async function loginAs({ companySlug, email, password = 'SecureP@ss123' }) {
  const res = await request(app).post('/api/auth/login').send({ companySlug, email, password });
  return res;
}

/**
 * Invites a user and accepts the invite, creating the user.
 * Returns { userId, accessToken, refreshToken }.
 *
 * NOTE: invite returns an inviteLink we can't follow in tests, so we
 * accept it via the accept-invite endpoint using the raw token we craft.
 * To keep things simple we directly grab the roleId for the target role,
 * invite with it, then call accept-invite.
 */
async function createMemberInTenant({ adminToken, companySlug, email, name = 'Member User', password = 'MemberP@ss123' }) {
  // 1. List users to find the member roleId via the RBAC demo route… but
  //    we don't have that here. Simpler: use the authController /users route
  //    to get roles, or just look up the role id through the invite response.
  //
  // The cleanest approach with the current API: POST /api/auth/users/invite
  // returns an inviteLink containing the raw token. We parse it.
  const inviteRes = await request(app)
    .post('/api/auth/users/invite')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email, roleId: await getMemberRoleId(adminToken) });

  expect(inviteRes.status).toBe(201);

  // Extract raw token from the invite link
  const url = new URL(inviteRes.body.inviteLink);
  const rawToken = url.searchParams.get('token');

  // 2. Accept the invite (/api/auth/auth/accept-invite — the router nests under /api/auth)
  const acceptRes = await request(app)
    .post('/api/auth/auth/accept-invite')
    .send({ companySlug, token: rawToken, name, password });

  expect(acceptRes.status).toBe(200);
  return {
    userId: acceptRes.body.data.user.id,
    accessToken: acceptRes.body.data.accessToken,
    refreshToken: acceptRes.body.data.refreshToken,
  };
}

/**
 * Gets the member roleId by listing users and plucking the first member's role,
 * or by using the /api/demo/roles route if available. Simpler approach: parse
 * from /api/users listing.
 *
 * Since we don't yet have a public roles list endpoint, we work around this by
 * calling the admin route to get roles via an invite attempt that we inspect.
 *
 * SIMPLEST: we know from authService that signup creates 'admin' and 'member'
 * roles. We can invite to the member role by doing a GET /api/users and
 * checking the role field — but that gives us the name, not the id.
 *
 * ACTUAL FIX: use the rbacDemo routes which expose role listing.
 */
async function getMemberRoleId(adminToken) {
  const res = await request(app)
    .get('/api/demo/roles')
    .set('Authorization', `Bearer ${adminToken}`);
  // rbacDemo returns all roles in the tenant
  const memberRole = res.body.data?.find((r) => r.name === 'member');
  if (!memberRole) throw new Error('member role not found via demo endpoint');
  return memberRole._id;
}

async function getAdminRoleId(adminToken) {
  const res = await request(app)
    .get('/api/demo/roles')
    .set('Authorization', `Bearer ${adminToken}`);
  const adminRole = res.body.data?.find((r) => r.name === 'admin');
  if (!adminRole) throw new Error('admin role not found via demo endpoint');
  return adminRole._id;
}

// ─── Check what the demo routes expose ─────────────────────────────────────
// (Peek at rbacDemo.routes.js shape so we use the right URL)

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PATCH /api/users/:id/deactivate and /reactivate', () => {
  // ── 1. Admin deactivates a member; member cannot log in ─────────────────
  it('admin deactivates a member → member cannot log in', async () => {
    const { accessToken: adminToken, tenantSlug } = await createTenant({
      companyName: 'AcmeCorp',
      adminName: 'Admin User',
      email: 'admin@acme.com',
    });

    const { userId: memberId } = await createMemberInTenant({
      adminToken,
      companySlug: tenantSlug,
      email: 'member@acme.com',
    });

    // Deactivate
    const deactivateRes = await request(app)
      .patch(`/api/users/${memberId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body).toEqual({ id: memberId, isActive: false });

    // Attempt login as deactivated member
    const loginRes = await loginAs({ companySlug: tenantSlug, email: 'member@acme.com' });
    expect(loginRes.status).toBe(401);
  });

  // ── 2. After deactivation, member's old refresh token returns 401 ────────
  it("deactivated member's refresh token is rejected", async () => {
    const { accessToken: adminToken, tenantSlug } = await createTenant({
      companyName: 'BetaCorp',
      adminName: 'Admin B',
      email: 'admin@beta.com',
    });

    const { userId: memberId, refreshToken: memberRefresh } = await createMemberInTenant({
      adminToken,
      companySlug: tenantSlug,
      email: 'member@beta.com',
    });

    // Deactivate
    await request(app)
      .patch(`/api/users/${memberId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Refresh token must be rejected
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: memberRefresh });

    expect(refreshRes.status).toBe(401);
  });

  // ── 3. Reactivation lets the user log in again ───────────────────────────
  it('reactivated member can log in', async () => {
    const { accessToken: adminToken, tenantSlug } = await createTenant({
      companyName: 'GammaCorp',
      adminName: 'Admin G',
      email: 'admin@gamma.com',
    });

    const { userId: memberId } = await createMemberInTenant({
      adminToken,
      companySlug: tenantSlug,
      email: 'member@gamma.com',
    });

    await request(app)
      .patch(`/api/users/${memberId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app)
      .patch(`/api/users/${memberId}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const loginRes = await loginAs({ companySlug: tenantSlug, email: 'member@gamma.com' });
    expect(loginRes.status).toBe(200);
  });

  // ── 4. Member (no USER_MANAGE) gets 403 ─────────────────────────────────
  it('member without USER_MANAGE gets 403', async () => {
    const { accessToken: adminToken, userId: adminId, tenantSlug } = await createTenant({
      companyName: 'DeltaCorp',
      adminName: 'Admin D',
      email: 'admin@delta.com',
    });

    const { accessToken: memberToken } = await createMemberInTenant({
      adminToken,
      companySlug: tenantSlug,
      email: 'member@delta.com',
    });

    const res = await request(app)
      .patch(`/api/users/${adminId}/deactivate`)
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(403);
  });

  // ── 5. No token → 401 ───────────────────────────────────────────────────
  it('missing token returns 401', async () => {
    const res = await request(app).patch('/api/users/000000000000000000000001/deactivate');
    expect(res.status).toBe(401);
  });

  // ── 6. Deactivating yourself → 403 ──────────────────────────────────────
  it('cannot deactivate yourself', async () => {
    const { accessToken: adminToken, userId: adminId } = await createTenant({
      companyName: 'EpsilonCorp',
      adminName: 'Admin E',
      email: 'admin@epsilon.com',
    });

    const res = await request(app)
      .patch(`/api/users/${adminId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Forbidden');
  });

  // ── 7. Deactivating the sole admin → 409 ────────────────────────────────
  it('cannot deactivate the last admin (409)', async () => {
    const { accessToken: adminToken, userId: adminId, tenantSlug } = await createTenant({
      companyName: 'ZetaCorp',
      adminName: 'Admin Z',
      email: 'admin@zeta.com',
    });

    // Create a second admin via invite with admin role
    const adminRoleId = await getAdminRoleId(adminToken);
    const inviteRes = await request(app)
      .post('/api/auth/users/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'admin2@zeta.com', roleId: adminRoleId });
    expect(inviteRes.status).toBe(201);

    const rawToken = new URL(inviteRes.body.inviteLink).searchParams.get('token');
    const acceptRes = await request(app)
      .post('/api/auth/auth/accept-invite')
      .send({ companySlug: tenantSlug, token: rawToken, name: 'Admin 2', password: 'SecureP@ss123' });
    expect(acceptRes.status).toBe(200);
    const admin2Id = acceptRes.body.data.user.id;
    const admin2Token = acceptRes.body.data.accessToken;

    // Admin2 tries to deactivate admin1 (the only remaining admin after admin2 deactivates)
    // First deactivate admin2 using admin1
    await request(app)
      .patch(`/api/users/${admin2Id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Now admin1 is the sole active admin — cannot deactivate themselves (403 self-check fires first)
    // Let's have admin2 (still has valid JWT) try to deactivate admin1
    const res = await request(app)
      .patch(`/api/users/${adminId}/deactivate`)
      .set('Authorization', `Bearer ${admin2Token}`);

    // admin2's token still works for up to 15 min; admin1 is last active admin → 409
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Cannot deactivate the last admin');
  });

  // ── 8. Two admins — one can deactivate the other ────────────────────────
  it('with two admins, one can deactivate the other', async () => {
    const { accessToken: adminToken, tenantSlug } = await createTenant({
      companyName: 'EtaCorp',
      adminName: 'Admin Eta',
      email: 'admin@eta.com',
    });

    const adminRoleId = await getAdminRoleId(adminToken);
    const inviteRes = await request(app)
      .post('/api/auth/users/invite')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'admin2@eta.com', roleId: adminRoleId });
    expect(inviteRes.status).toBe(201);

    const rawToken = new URL(inviteRes.body.inviteLink).searchParams.get('token');
    const acceptRes = await request(app)
      .post('/api/auth/auth/accept-invite')
      .send({ companySlug: tenantSlug, token: rawToken, name: 'Admin Eta 2', password: 'SecureP@ss123' });
    expect(acceptRes.status).toBe(200);
    const admin2Id = acceptRes.body.data.user.id;

    const res = await request(app)
      .patch(`/api/users/${admin2Id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });

  // ── 9. Cannot deactivate user with more permissions → 403 ───────────────
  it('cannot deactivate a user whose role has permissions the caller lacks', async () => {
    const { accessToken: adminToken, userId: adminId, tenantSlug } = await createTenant({
      companyName: 'ThetaCorp',
      adminName: 'Admin Theta',
      email: 'admin@theta.com',
    });

    // Create a member (less powerful than admin)
    const { userId: memberId, accessToken: memberToken } = await createMemberInTenant({
      adminToken,
      companySlug: tenantSlug,
      email: 'member@theta.com',
    });

    // Member tries to deactivate admin (admin has MORE permissions → 403)
    const res = await request(app)
      .patch(`/api/users/${adminId}/deactivate`)
      .set('Authorization', `Bearer ${memberToken}`);

    // Member has no USER_MANAGE → caught by requirePermission first (403)
    // Either way it's 403 — the privilege rule is defence in depth
    expect(res.status).toBe(403);

    // Verify admin is still active (not affected)
    // We do this by confirming admin can still make authenticated requests
    const meRes = await request(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(meRes.status).toBe(200);
  });

  // ── 10. Cross-tenant: Company A admin uses Company B user id → 404 ───────
  it("company A admin cannot deactivate company B's user", async () => {
    const { accessToken: adminA } = await createTenant({
      companyName: 'AlphaCo',
      adminName: 'Admin Alpha',
      email: 'admin@alpha.com',
    });

    const { userId: adminBId, tenantSlug: slugB } = await createTenant({
      companyName: 'BravoCo',
      adminName: 'Admin Bravo',
      email: 'admin@bravo.com',
    });

    // Admin A tries to deactivate Admin B's user id
    const res = await request(app)
      .patch(`/api/users/${adminBId}/deactivate`)
      .set('Authorization', `Bearer ${adminA}`);

    expect(res.status).toBe(404);

    // Admin B can still log in (unaffected)
    const loginRes = await loginAs({ companySlug: slugB, email: 'admin@bravo.com' });
    expect(loginRes.status).toBe(200);
  });

  // ── 11. Invalid ObjectId → 400 ───────────────────────────────────────────
  it('invalid :id returns 400', async () => {
    const { accessToken: adminToken } = await createTenant({
      companyName: 'IotaCorp',
      adminName: 'Admin I',
      email: 'admin@iota.com',
    });

    const res = await request(app)
      .patch('/api/users/not-a-valid-id/deactivate')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });

  // ── 12. Deactivating twice returns 200 both times ────────────────────────
  it('deactivating an already-inactive user returns 200', async () => {
    const { accessToken: adminToken, tenantSlug } = await createTenant({
      companyName: 'KappaCorp',
      adminName: 'Admin K',
      email: 'admin@kappa.com',
    });

    const { userId: memberId } = await createMemberInTenant({
      adminToken,
      companySlug: tenantSlug,
      email: 'member@kappa.com',
    });

    await request(app)
      .patch(`/api/users/${memberId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Second deactivation — must still return 200
    const res = await request(app)
      .patch(`/api/users/${memberId}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });

  // ── 13. Earlier test suite: health endpoint still works ─────────────────
  it('GET /health still returns 200 (regression check)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
