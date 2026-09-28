/**
 * Fixed list of every permission key in the system.
 *
 * WHY a constant file instead of a database table:
 * Permissions are part of the CODE CONTRACT — they map 1-to-1 to
 * things the API can do. Keeping them in code means a developer
 * can grep for 'project:delete' and find every place it's checked.
 * Roles (which ARE in the database) hold arrays of these keys.
 */

const PERMISSIONS = Object.freeze({
  // Projects
  PROJECT_CREATE: 'project:create',
  PROJECT_READ:   'project:read',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',

  // Tasks
  TASK_CREATE: 'task:create',
  TASK_READ:   'task:read',
  TASK_UPDATE: 'task:update',
  TASK_DELETE: 'task:delete',

  // User management
  USER_INVITE: 'user:invite',
  USER_MANAGE: 'user:manage',

  // Billing
  BILLING_VIEW:   'billing:view',
  BILLING_MANAGE: 'billing:manage',
});

/** Flat array of all permission key strings, useful for validation. */
export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export default PERMISSIONS;
