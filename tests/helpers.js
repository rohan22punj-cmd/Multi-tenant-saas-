/**
 * Shared helpers for the project / task / plan / activity suites.
 *
 * Every helper goes through the real HTTP API wherever possible, so the
 * tests exercise the same path a client would. The only direct database
 * access is for setup that has no public endpoint (creating a member user,
 * changing a plan), and those calls run inside an explicit tenant context.
 */

import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../src/app.js';
import User from '../src/models/User.js';
import Role from '../src/models/Role.js';
import { runWithTenant } from '../src/utils/tenantContext.js';

export const auth = (token) => ({ Authorization: `Bearer ${token}` });

let companyCounter = 0;

/**
 * Signs up a company through the public endpoint.
 * Returns the admin token plus the ids a test needs.
 */
export async function signupCompany({
  companyName,
  adminName = 'Admin User',
  email,
  password = 'pass1234',
} = {}) {
  companyCounter += 1;
  const name = companyName || `Test Company ${companyCounter}`;
  const adminEmail = email || `admin${companyCounter}@example.com`;

  const res = await request(app)
    .post('/api/auth/signup')
    .send({ companyName: name, adminName, email: adminEmail, password });

  if (res.status !== 201) {
    throw new Error(
      `signup failed (${res.status}): ${JSON.stringify(res.body)}`
    );
  }

  return {
    token: res.body.data.accessToken,
    userId: res.body.data.user.id,
    tenantId: res.body.data.user.tenantId,
    roleId: res.body.data.user.roleId,
    slug: res.body.data.tenant.slug,
    companyName: name,
    email: adminEmail,
    password,
  };
}

/**
 * Creates a user directly in a company (no invite endpoint exists yet).
 * Optionally deactivated, which the public API cannot do for a fresh user.
 */
export async function createCompanyUser(
  company,
  {
    name = 'Member User',
    email,
    password = 'pass1234',
    roleName = 'member',
    isActive = true,
  } = {}
) {
  const userEmail = email || `member-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { tenantId } = company;

  const role = await runWithTenant({ tenantId }, () =>
    Role.findOne({ name: roleName })
  );
  if (!role) {
    throw new Error(`role "${roleName}" not found for tenant`);
  }

  const passwordHash = await bcrypt.hash(password, 4);

  const user = await runWithTenant({ tenantId }, () =>
    User.create({ tenantId, name, email: userEmail, passwordHash, roleId: role._id, isActive })
  );

  return { id: user._id.toString(), email: userEmail, password };
}

/** Creates a member user and logs them in, returning their access token. */
export async function loginAsMember(company, options = {}) {
  const user = await createCompanyUser(company, options);
  const res = await request(app)
    .post('/api/auth/login')
    .send({
      companySlug: company.slug,
      email: user.email,
      password: user.password,
    });

  if (res.status !== 200) {
    throw new Error(`login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  return { ...user, token: res.body.data.accessToken };
}

/** Creates a project as the given token, returning the supertest response. */
export function createProject(token, body = { name: 'A project' }) {
  return request(app).post('/api/projects').set(auth(token)).send(body);
}

/** Creates a task inside a project, returning the supertest response. */
export function createTask(token, projectId, body = { title: 'A task' }) {
  return request(app)
    .post(`/api/projects/${projectId}/tasks`)
    .set(auth(token))
    .send(body);
}
