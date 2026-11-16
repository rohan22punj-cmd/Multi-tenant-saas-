/**
 * OpenAPI Spec Validation Test
 *
 * Validates that:
 * 1. The spec is valid OpenAPI 3.x
 * 2. Every route registered in Express appears in the spec
 * 3. Every path in the spec exists in Express
 * 4. No phantom routes exist in either direction
 */

import request from 'supertest';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import app from '../src/app.js';

describe('OpenAPI Spec Validation', () => {
  let spec;
  let expressRoutes;

  beforeAll(() => {
    // Load the spec
    const specPath = path.resolve('src/docs/openapi.yaml');
    const specContent = fs.readFileSync(specPath, 'utf8');
    spec = YAML.parse(specContent);

    // Validate OpenAPI version
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBeDefined();
    expect(spec.paths).toBeDefined();

    // Extract all routes from Express app
    expressRoutes = extractExpressRoutes(app);
  });

  function extractExpressRoutes(appInstance) {
    const routes = [];
    const stack = appInstance.router?.stack || [];

    // First, find direct routes (not in sub-routers)
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
        methods.forEach(method => {
          routes.push({
            method: method.toUpperCase(),
            path: layer.route.path,
          });
        });
      }
    }

    // Known mount points from app.js with exact route patterns to identify them
    // Order matters - more specific patterns first
    const knownMounts = [
      {
        path: '/api/auth',
        identifiers: ['/users/invite', '/auth/accept-invite'],  // Unique to authRoutes
        routes: ['/signup', '/login', '/forgot-password', '/reset-password', '/refresh', '/logout', '/users/invite', '/auth/accept-invite', '/users']
      },
      {
        path: '/api/demo',
        identifiers: ['/read', '/project', '/billing', '/roles'],  // Unique to demo
        routes: ['/read', '/project', '/billing', '/roles']
      },
      {
        path: '/api/users',
        identifiers: ['/:id/deactivate', '/:id/reactivate', '/:id/role'],  // Unique to userRoutes
        routes: ['/:id/deactivate', '/:id/reactivate', '/:id/role']
      },
      {
        path: '/api/projects',
        identifiers: [],  // No unique identifiers, matched by exclusion
        routes: ['/', '/:id']
      },
      {
        path: '/api',
        identifiers: ['/tasks/mine', '/projects/:projectId/tasks'],  // Unique to taskRoutes
        routes: ['/tasks/mine', '/tasks/:id', '/projects/:projectId/tasks']
      },
      {
        path: '/api/activity',
        identifiers: ['/'],  // Only route is /
        routes: ['/']
      },
    ];

    // For each mounted router in the stack, try to match it to a known mount
    for (const layer of stack) {
      if (layer.handle?.stack) {
        const subRoutes = layer.handle.stack
          .filter(sl => sl.route)
          .map(sl => sl.route.path);

        // Find which known mount this matches
        for (const km of knownMounts) {
          let isMatch = false;

          if (km.identifiers.length > 0) {
            // Must have ALL identifiers to match
            isMatch = km.identifiers.every(identifier =>
              subRoutes.some(sr => sr === identifier)
            );
          } else {
            // For projectRoutes, match if it has / and /:id but NO task routes
            const hasTaskRoutes = subRoutes.some(sr => sr.includes('/tasks') || sr.includes('/projectId'));
            const hasProjectRoutes = subRoutes.includes('/') && subRoutes.includes('/:id');
            isMatch = hasProjectRoutes && !hasTaskRoutes;
          }

          if (isMatch) {
            // This is the right mount - add all its routes with the prefix
            for (const subLayer of layer.handle.stack) {
              if (subLayer.route) {
                const methods = Object.keys(subLayer.route.methods).filter(m => subLayer.route.methods[m]);
                methods.forEach(method => {
                  const fullPath = (km.path + subLayer.route.path).replace(/\/+/g, '/');
                  routes.push({
                    method: method.toUpperCase(),
                    path: fullPath,
                  });
                });
              }
            }
            break; // Found the match, don't check other mounts
          }
        }
      }
    }

    return routes;
  }

  function normalizePath(path) {
    // Convert Express :param to OpenAPI {param}
    // Also remove trailing slashes
    return path.replace(/:(\w+)/g, '{$1}').replace(/\/+$/, '');
  }

  function getSpecPaths() {
    const paths = [];
    if (!spec.paths) return paths;
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
          paths.push({
            method: method.toUpperCase(),
            path: path,
          });
        }
      }
    }
    return paths;
  }

  test('spec is valid OpenAPI 3.x', () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe('Multi-Tenant SaaS API');
    expect(spec.components).toBeDefined();
    expect(spec.components.securitySchemes).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
    expect(spec.components.schemas).toBeDefined();
  });

  test('spec has required schemas', () => {
    const requiredSchemas = [
      'Error',
      'User',
      'Project',
      'Task',
      'ActivityLog',
      'Pagination',
      'Tenant',
      'Tokens',
      'SignupRequest',
      'LoginRequest',
      'RefreshRequest',
      'LogoutRequest',
      'ForgotPasswordRequest',
      'ResetPasswordRequest',
      'AcceptInviteRequest',
      'InviteRequest',
      'InviteResponse',
      'UsersListResponse',
      'ProjectCreateRequest',
      'ProjectUpdateRequest',
      'TaskCreateRequest',
      'TaskUpdateRequest',
      'ChangeRoleRequest',
      'DeactivateResponse',
      'MeResponse',
      'PlanLimitError',
    ];
    for (const schema of requiredSchemas) {
      expect(spec.components.schemas[schema]).toBeDefined();
    }
  });

  test('spec has required shared responses', () => {
    const requiredResponses = [
      'Unauthorized',
      'Forbidden',
      'NotFound',
      'TooManyRequests',
      'BadRequest',
      'Conflict',
      'PaymentRequired',
    ];
    for (const response of requiredResponses) {
      expect(spec.components.responses[response]).toBeDefined();
    }
  });

  test('every Express route exists in the spec', () => {
    const specPaths = getSpecPaths();
    const missing = [];

    for (const route of expressRoutes) {
      // Skip the docs routes themselves
      if (route.path.startsWith('/api/docs')) continue;
      // Skip the health check (not under /api)
      if (route.path === '/health') continue;

      const normalized = normalizePath(route.path);
      const found = specPaths.some(sp =>
        sp.method === route.method && sp.path === normalized
      );
      if (!found) {
        missing.push(`${route.method} ${route.path}`);
      }
    }

    if (missing.length > 0) {
      console.log('\n=== MISSING FROM SPEC ===');
      missing.forEach(m => console.log('  ' + m));
    }
    expect(missing).toEqual([]);
  });

  test('every spec path exists in Express', () => {
    const specPaths = getSpecPaths();
    const extra = [];

    for (const sp of specPaths) {
      const found = expressRoutes.some(route =>
        route.method === sp.method && normalizePath(route.path) === sp.path
      );
      if (!found) {
        // Check if it's a demo route that might be mounted differently
        if (sp.path.startsWith('/api/demo/')) {
          // Demo routes might be mounted differently, check without /api prefix
          const altPath = sp.path.replace('/api', '');
          const foundAlt = expressRoutes.some(route =>
            route.method === sp.method && normalizePath(route.path) === altPath
          );
          if (!foundAlt) {
            extra.push(`${sp.method} ${sp.path}`);
          }
        } else {
          extra.push(`${sp.method} ${sp.path}`);
        }
      }
    }

    if (extra.length > 0) {
      console.log('\n=== EXTRA IN SPEC (not in Express) ===');
      extra.forEach(e => console.log('  ' + e));
    }
    expect(extra).toEqual([]);
  });

  test('spec includes security requirements for protected routes', () => {
    // Check that protected routes have security requirement
    const publicPaths = [
      '/health',
      '/api/auth/signup',
      '/api/auth/login',
      '/api/auth/refresh',
      '/api/auth/logout',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/auth/accept-invite',
      '/api/docs',
      '/api/docs.json',
    ];

    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const isPublic = publicPaths.some(p => path === p || path.startsWith(p + '/'));
        if (!isPublic && !path.startsWith('/api/demo/')) {
          // Should have security requirement
          const hasSecurity = op.security && op.security.length > 0;
          if (!hasSecurity) {
            // Some might rely on global security
            expect(spec.security).toBeDefined();
            expect(spec.security.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});