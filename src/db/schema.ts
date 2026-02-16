import { pgTable, serial, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// DB1: Normalized student table (source)
export const students = pgTable('students', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  age: integer('age'),
  course: text('course'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// DB2: Target table with JSONB column
export const studentSnapshots = pgTable('student_snapshots', {
  id: serial('id').primaryKey(),
  studentId: integer('student_id').notNull().unique(),
  data: jsonb('data').notNull(),
  lastSyncedAt: timestamp('last_synced_at').defaultNow().notNull(),
  syncStatus: text('sync_status').default('pending'), // 'pending', 'synced', 'failed', 'deleted'
});

// Sync logs table for tracking all operations
export const syncLogs = pgTable('sync_logs', {
  id: serial('id').primaryKey(),
  recordId: integer('record_id').notNull(),
  operation: text('operation').notNull(), // 'INSERT', 'UPDATE', 'DELETE', 'BACKFILL'
  status: text('status').notNull(), // 'success', 'failed', 'retry'
  errorDetails: text('error_details'),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  metadata: jsonb('metadata'), // For additional context like retry count
});