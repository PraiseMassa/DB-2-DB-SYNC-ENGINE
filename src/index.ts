import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { students, studentSnapshots, syncLogs } from './db/schema';
import { eq, sql } from 'drizzle-orm';
import { startRealtimeListener } from './realtime-listener';

type Bindings = {
  DATABASE_URL: string;
  WORKER_DATABASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SYNC_QUEUE: Queue;
};

type QueueMessage = {
  recordId: number;
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'DEBUG';
  data: any;
  retryCount: number;
  timestamp: string;
};

type Variables = {
  db: ReturnType<typeof drizzle>;
  listenerStarted: boolean;
};

// Create Hono app with proper typing
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Middleware for database connection
app.use('*', async (c, next) => {
  const client = postgres(c.env.WORKER_DATABASE_URL || c.env.DATABASE_URL);
  const db = drizzle(client);
  c.set('db', db);
  await next();
});

// Health check
app.get('/', (c) => c.json({ 
  status: 'ok', 
  message: 'DB Sync Engine Running',
  timestamp: new Date().toISOString()
}));

// Manual sync endpoint (for back-filling)
app.post('/api/sync/backfill', async (c) => {
  try {
    const db = c.get('db');
    
    // Get all students from DB1
    const allStudents = await db.select().from(students);
    
    const results = await Promise.allSettled(
      allStudents.map(async (student) => {
        try {
          // Queue each student for sync
          await c.env.SYNC_QUEUE.send({
            recordId: student.id,
            operation: 'INSERT',
            data: student,
            timestamp: new Date().toISOString(),
            retryCount: 0
          });
          
          return { id: student.id, status: 'queued' };
        } catch (error: any) {
          return { id: student.id, status: 'failed', error: error.message };
        }
      })
    );
    
    const summary = {
      total: allStudents.length,
      queued: results.filter(r => r.status === 'fulfilled' && (r as any).value?.status === 'queued').length,
      failed: results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && (r as any).value?.status === 'failed')).length,
    };
    
    return c.json({ 
      message: 'Backfill initiated', 
      summary,
      note: 'Records have been queued for sync. Check /api/sync/logs for status.'
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get sync status for a specific student or summary
app.get('/api/sync/status/:studentId?', async (c) => {
  try {
    const db = c.get('db');
    const studentId = c.req.param('studentId');
    
    if (studentId) {
      const snapshot = await db
        .select()
        .from(studentSnapshots)
        .where(eq(studentSnapshots.studentId, parseInt(studentId)))
        .limit(1);
      
      return c.json(snapshot[0] || { error: 'Not found' });
    }
    
    // Get summary stats with proper typing
    const stats = await db
      .select({
        status: studentSnapshots.syncStatus,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(studentSnapshots)
      .groupBy(studentSnapshots.syncStatus);
    
    return c.json(stats);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get sync logs with optional status filter
app.get('/api/sync/logs', async (c) => {
  try {
    const db = c.get('db');
    const limit = parseInt(c.req.query('limit') || '100');
    const status = c.req.query('status');
    
    // Build query with proper typing
    let query = db.select().from(syncLogs);
    
    if (status) {
      // Use type assertion to help TypeScript
      const filteredQuery = query.where(eq(syncLogs.status, status));
      query = filteredQuery as typeof query;
    }
    
    const logs = await query
      .orderBy(sql`timestamp desc`)
      .limit(limit);
    
    return c.json(logs);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Alternative logs endpoint using raw SQL if type issues persist
app.get('/api/sync/logs-raw', async (c) => {
  try {
    const client = postgres(c.env.WORKER_DATABASE_URL || c.env.DATABASE_URL);
    const limit = parseInt(c.req.query('limit') || '100');
    const status = c.req.query('status');
    
    let query = 'SELECT * FROM sync_logs';
    const params: any[] = [];
    
    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }
    
    query += ' ORDER BY timestamp DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    
    const logs = await client.unsafe(query, params);
    
    return c.json(logs);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Reconcile endpoint (check for out-of-sync records)
app.post('/api/sync/reconcile', async (c) => {
  try {
    const db = c.get('db');
    
    // Get all students and their snapshots
    const allStudents = await db.select().from(students);
    const allSnapshots = await db.select().from(studentSnapshots);
    
    const snapshotMap = new Map(allSnapshots.map(s => [s.studentId, s]));
    
    const outOfSync: Array<{ id: number; issue: string }> = [];
    
    for (const student of allStudents) {
      const snapshot = snapshotMap.get(student.id);
      
      if (!snapshot) {
        outOfSync.push({ id: student.id, issue: 'missing_in_db2' });
        continue;
      }
      
      // Compare data safely with type assertion
      const snapshotData = snapshot.data as typeof student;
      if (JSON.stringify(snapshotData) !== JSON.stringify(student)) {
        outOfSync.push({ id: student.id, issue: 'data_mismatch' });
      }
    }
    
    // Also check for snapshots without source records
    for (const snapshot of allSnapshots) {
      if (!allStudents.some(s => s.id === snapshot.studentId)) {
        outOfSync.push({ id: snapshot.studentId, issue: 'orphaned_in_db2' });
      }
    }
    
    return c.json({
      totalStudents: allStudents.length,
      totalSnapshots: allSnapshots.length,
      outOfSyncCount: outOfSync.length,
      outOfSync,
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Manual retry for failed records
app.post('/api/sync/retry-failed', async (c) => {
  try {
    const db = c.get('db');
    
    // Get all failed snapshots
    const failed = await db
      .select()
      .from(studentSnapshots)
      .where(eq(studentSnapshots.syncStatus, 'failed'));
    
    for (const record of failed) {
      await c.env.SYNC_QUEUE.send({
        recordId: record.studentId,
        operation: 'UPDATE',
        data: record.data,
        retryCount: 0,
        timestamp: new Date().toISOString()
      });
    }
    
    return c.json({ 
      message: `Retried ${failed.length} failed records`,
      count: failed.length 
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// ES Modules format export
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    try {
      console.log('📞 Request received:', request.url);
      
      // Start Realtime listener in the background
      ctx.waitUntil((async () => {
        try {
          console.log('🚀 Starting Realtime listener...');
          console.log('Supabase URL:', env.SUPABASE_URL ? '✓ Set' : '✗ Missing');
          console.log('Service Role Key:', env.SUPABASE_SERVICE_ROLE_KEY ? '✓ Set' : '✗ Missing');
          
          await startRealtimeListener(env);
          console.log('✅ Realtime listener started successfully');
        } catch (error) {
          console.error('❌ Failed to start Realtime listener:', error);
          console.error('Error details:', JSON.stringify(error, null, 2));
        }
      })());

      // Use the app directly
      return await app.fetch(request, env, ctx);
    } catch (error: any) {
      console.error('❌ Fetch handler error:', error);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Bindings) {
    console.log(`📦 Queue received batch of ${batch.messages.length} messages`);
    // ... rest of your queue handler (keep as is)
  }
};

app.get('/api/debug/realtime', async (c) => {
  return c.json({ 
    message: 'Realtime listener should be running in the background',
    note: 'Check the console logs from wrangler dev to see if the listener started'
  });
});

// Check queue stats
app.get('/api/debug/queue', async (c) => {
  try {
    // Send a test message to the queue
    await c.env.SYNC_QUEUE.send({
      recordId: 999999,
      operation: 'DEBUG',
      data: { test: true, timestamp: new Date().toISOString() },
      retryCount: 0
    });
    
    return c.json({ 
      message: 'Test message sent to queue',
      queueBinding: 'SYNC_QUEUE exists and is configured'
    });
  } catch (error: any) {
    return c.json({ 
      error: 'Queue not working',
      details: error.message 
    }, 500);
  }
});

// Force restart Realtime listener
app.post('/api/debug/restart-realtime', async (c) => {
  try {
    // @ts-ignore - access internal function
    const { startRealtimeListener } = await import('./realtime-listener');
    
    // Run in background
    c.executionCtx.waitUntil((async () => {
      console.log('🔄 Manually restarting Realtime listener...');
      await startRealtimeListener(c.env);
    })());
    
    return c.json({ message: 'Realtime listener restart triggered' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});