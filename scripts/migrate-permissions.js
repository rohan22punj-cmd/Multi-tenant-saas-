/**
 * Migration: Ensure all existing roles have only valid permission keys.
 * 
 * Runs unscoped (Tenant has no tenantId). For each role, checks if any
 * permission keys are not in the ALL_PERMISSIONS list. If so, removes
 * invalid keys. If a role ends up with no permissions, it resets to the
 * default 'member' permissions.
 * 
 * This is safe to run once. After the first successful run, subsequent
 * runs find no invalid keys and exit quietly.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { PERMISSIONS, ALL_PERMISSIONS, DEFAULT_ROLES } from '../src/constants/permissions.js';
import Tenant from '../src/models/Tenant.js';
import Role from '../src/models/Role.js';

dotenv.config();

async function migrate() {
  // Connect to the test database (same as tests use)
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/multitenant';
  await mongoose.connect(uri);
  
  try {
    // Fetch all roles unscoped (Tenant has no tenantId, so no filtering needed)
    const roles = await Role.find({}, { name: 1, permissions: 1 }).lean();
    
    let changed = 0;
    
    for (const roleDoc of roles) {
      const invalidKeys = roleDoc.permissions.filter(
        (key) => !ALL_PERMISSIONS.includes(key)
      );
      
      if (invalidKeys.length > 0) {
        // Filter out invalid keys
        const validPermissions = roleDoc.permissions.filter(
          (key) => ALL_PERMISSIONS.includes(key)
        );
        
        // If after filtering there are no permissions left, reset to default
        const newPermissions = validPermissions.length > 0
          ? validPermissions
          : [...DEFAULT_ROLES.member];
        
        await Role.updateOne(
          { _id: roleDoc._id },
          { $set: { permissions: newPermissions } }
        );
        
        console.log(`Role "${roleDoc.name}": removed ${invalidKeys.join(', ')}, set to ${newPermissions.join(', ')}`);
        changed++;
      }
    }
    
    if (changed === 0) {
      console.log('No roles needed migration — all permissions are valid.');
    } else {
      console.log(`\nMigration complete: ${changed} role(s) updated.`);
    }
  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

migrate();