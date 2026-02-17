import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { students, studentSnapshots, syncLogs } from './db/schema';
import { eq, sql } from 'drizzle-orm';
import { startRealtimeListener } from './realtime-http';

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
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  data: any;
  retryCount: number;
  timestamp: string;
};

type Variables = {
  db: ReturnType<typeof drizzle>;
  listenerStarted: boolean;
};

// Create Hono app
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

// Backfill endpoint - sync all existing students
app.post('/api/sync/backfill', async (c) => {
  try {
    const db = c.get('db');
    const allStudents = await db.select().from(students);
    
    const results = await Promise.allSettled(
      allStudents.map(async (student) => {
        try {
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
    
    return c.json({ message: 'Backfill initiated', summary });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Get sync status for a student or summary
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

// Get sync logs
app.get('/api/sync/logs', async (c) => {
  try {
    const db = c.get('db');
    const limit = parseInt(c.req.query('limit') || '100');
    const status = c.req.query('status');
    
    let query = db.select().from(syncLogs);
    
    if (status) {
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

// Reconcile endpoint - check for out-of-sync records
app.post('/api/sync/reconcile', async (c) => {
  try {
    const db = c.get('db');
    
    const allStudents = await db.select().from(students);
    const allSnapshots = await db.select().from(studentSnapshots);
    
    const snapshotMap = new Map(allSnapshots.map(s => [s.studentId, s]));
    const outOfSync: Array<{ id: number; issue: string }> = [];
    
    // Check for missing or mismatched records
    for (const student of allStudents) {
      const snapshot = snapshotMap.get(student.id);
      
      if (!snapshot) {
        outOfSync.push({ id: student.id, issue: 'missing_in_db2' });
        continue;
      }
      
      const snapshotData = snapshot.data as typeof student;
      if (JSON.stringify(snapshotData) !== JSON.stringify(student)) {
        outOfSync.push({ id: student.id, issue: 'data_mismatch' });
      }
    }
    
    // Check for orphaned snapshots (deleted students)
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

// Retry failed records
app.post('/api/sync/retry-failed', async (c) => {
  try {
    const db = c.get('db');
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
    
    return c.json({ message: `Retried ${failed.length} failed records` });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Manual poll trigger
app.post('/api/sync/poll', async (c) => {
  try {
    c.executionCtx.waitUntil((async () => {
      const { manualPoll } = await import('./realtime-http');
      await manualPoll(c.env);
    })());
    
    return c.json({ message: 'Polling started' });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// ES Modules export
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    try {
      console.log('📞 Request received:', request.url);
      
      // Start Realtime listener in background
      ctx.waitUntil((async () => {
        try {
          console.log('🚀 Starting Realtime listener...');
          await startRealtimeListener(env);
          console.log('✅ Realtime listener started');
        } catch (error) {
          console.error('❌ Failed to start Realtime listener:', error);
        }
      })());

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
    
    const client = postgres(env.WORKER_DATABASE_URL || env.DATABASE_URL);
    const db = drizzle(client);
    
    for (const message of batch.messages) {
      const { recordId, operation, data, retryCount = 0 } = message.body;
      
      console.log(`🔄 Processing: ${operation} for record ${recordId} (attempt ${retryCount + 1})`);
      
      try {
        const sanitizedData = data ? JSON.parse(JSON.stringify(data)) : null;
        
        switch (operation) {
          case 'INSERT':
          case 'UPDATE':
            // Check if snapshot exists
            const existing = await db
              .select()
              .from(studentSnapshots)
              .where(eq(studentSnapshots.studentId, recordId))
              .limit(1);
            
            if (existing.length > 0) {
              // Update existing snapshot
              await db
                .update(studentSnapshots)
                .set({
                  data: sanitizedData,
                  lastSyncedAt: new Date(),
                  syncStatus: 'synced'
                })
                .where(eq(studentSnapshots.studentId, recordId));
              console.log(`✅ Updated snapshot for record ${recordId}`);
            } else {
              // Insert new snapshot
              await db.insert(studentSnapshots).values({
                studentId: recordId,
                data: sanitizedData,
                syncStatus: 'synced'
              });
              console.log(`✅ Inserted snapshot for record ${recordId}`);
            }
            break;
            
          case 'DELETE':
  console.log(`🗑️ Processing DELETE for record ${recordId}`);
  
  // Now this will work with the NOT NULL constraint removed
  await db
    .update(studentSnapshots)
    .set({
      data: null,  // Now allowed!
      lastSyncedAt: new Date(),
      syncStatus: 'deleted'
    })
    .where(eq(studentSnapshots.studentId, recordId));
  
  console.log(`✅ Marked record ${recordId} as deleted`);
  break;
        }
        
        // Log success
        await db.insert(syncLogs).values({
          recordId,
          operation,
          status: 'success',
          metadata: { retryCount, timestamp: new Date().toISOString() }
        });
        
        await message.ack();
        
      } catch (error: any) {
        console.error(`❌ Failed to sync record ${recordId}:`, error.message);
        
        // Log failure
        try {
          await db.insert(syncLogs).values({
            recordId,
            operation,
            status: 'failed',
            errorDetails: error.message,
            metadata: { retryCount, timestamp: new Date().toISOString() }
          });
        } catch (logError) {
          console.error('❌ Failed to log error:', logError);
        }
        
        // Retry with exponential backoff
        if (retryCount < 3) {
          const delaySeconds = Math.pow(2, retryCount) * 5;
          console.log(`⏰ Retrying in ${delaySeconds}s`);
          await message.retry({ delaySeconds });
        } else {
          console.log(`❌ Max retries exceeded for record ${recordId}`);
          await message.ack();
        }
      }
    }
    
    await client.end();
  }
};