/**
 * Task model — a task inside a project.
 *
 * BELONGS TO one tenant AND one project. status is todo / in-progress / done
 * (default todo). assigneeId is optional; when set, the user must be in the
 * same company and active (enforced in the service layer, because the
 * tenant plugin already scopes the User lookup).
 *
 * position is a number used to order tasks inside a project (kanban-like).
 *
 * TENANT PLUGIN:
 * Applied below, so every query is scoped to the current tenant.
 */

import mongoose from 'mongoose';
import tenantPlugin from '../plugins/tenantPlugin.js';

const taskSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: [true, 'Project ID is required'],
    },
    title: {
      type: String,
      required: [true, 'Task title is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['todo', 'in-progress', 'done'],
      default: 'todo',
    },
    assigneeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Created by user ID is required'],
    },
    dueDate: {
      type: Date,
    },
    position: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// Tasks of one project filtered by status, and "my tasks" lookups.
taskSchema.index({ tenantId: 1, projectId: 1, status: 1 });
taskSchema.index({ tenantId: 1, assigneeId: 1 });

taskSchema.plugin(tenantPlugin);

const Task = mongoose.model('Task', taskSchema);
export default Task;
