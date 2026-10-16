/**
 * Re-exports the canonical permission constant definitions from src/constants/permissions.js.
 * Keeps the existing import path working for any code that already imports from this module.
 */

import { PERMISSIONS, ALL_PERMISSIONS, DEFAULT_ROLES } from '../constants/permissions.js';

export { PERMISSIONS, ALL_PERMISSIONS, DEFAULT_ROLES };

export default PERMISSIONS;