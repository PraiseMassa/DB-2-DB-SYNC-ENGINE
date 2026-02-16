import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { studentSnapshots, syncLogs } from './db/schema';
import { eq, sql } from 'drizzle-orm';

export interface Env {
  DATABASE_URL: string;
  WORKER_DATABASE_URL: string;
  SYNC_QUEUE: Queue;
}

export interface SyncMessage {
  recordId: number;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  data: any;
  retryCount?: number;
  timestamp?: string;
}

export default {
  async queue(batch: MessageBatch<SyncMessage>, env: Env): Promise<void> {
    console.log(`Processing batch of ${batch.messages.length} messages`);
    
    // Create database connection
    const client = postgres(env.WORKER_DATABASE_URL || env.DATABASE_URL);
    const db = drizzle(client);
    
    const results = [];
    
    for (const message of batch.messages) {
      const { recordId, operation, data, retryCount = 0 } = message.body;
      const startTime = Date.now();
      
      try {
        console.log(`Processing ${operation} for record ${recordId} (attempt ${retryCount + 1})`);
        
        // Process the sync based on operation type
        await processSyncOperation(db, recordId, operation, data);
        
        // Log success
        await db.insert(syncLogs).values({
          recordId,
          operation,
          status: 'success',
          metadata: {
            retryCount,
            processingTimeMs: Date.now() - startTime,
            timestamp: new Date().toISOString()
          }
        });
        
        console.log(`✅ Successfully synced record ${recordId}`);
        await message.ack();
        
      } catch (error: any) {
        console.error(`❌ Failed to sync record ${recordId}:`, error.message);
        
        // Log the failure
        await db.insert(syncLogs).values({
          recordId,
          operation,
          status: 'failed',
          errorDetails: error.message,
          metadata: {
            retryCount,
            error: {
              name: error.name,
              stack: error.stack,
            },
            timestamp: new Date().toISOString()
          }
        });
        
        // Calculate next retry with exponential backoff
        const maxRetries = 5;
        const newRetryCount = retryCount + 1;
        
        if (newRetryCount <= maxRetries) {
          // Exponential backoff: 5s, 10s, 20s, 40s, 80s
          const delaySeconds = Math.min(5 * Math.pow(2, retryCount), 300); // Cap at 5 minutes
          
          console.log(`⏰ Scheduling retry ${newRetryCount}/${maxRetries} for record ${recordId} in ${delaySeconds}s`);
          
          // Requeue with incremented retry count
          await message.retry({
            delaySeconds,
          });
          
          // Log retry attempt
          await db.insert(syncLogs).values({
            recordId,
            operation,
            status: 'retry',
            errorDetails: `Retry ${newRetryCount}/${maxRetries} scheduled in ${delaySeconds}s: ${error.message}`,
            metadata: {
              retryCount: newRetryCount,
              delaySeconds,
              nextRetryTimestamp: new Date(Date.now() + delaySeconds * 1000).toISOString()
            }
          });
        } else {
          // Max retries exceeded - mark as permanently failed
          console.log(`❌ Max retries exceeded for record ${recordId}`);
          
          // Update snapshot status to failed
          await db
            .update(studentSnapshots)
            .set({ 
              syncStatus: 'failed',
              lastSyncedAt: new Date()
            })
            .where(eq(studentSnapshots.studentId, recordId));
          
          // Log permanent failure
          await db.insert(syncLogs).values({
            recordId,
            operation,
            status: 'failed',
            errorDetails: `Max retries (${maxRetries}) exceeded. Last error: ${error.message}`,
            metadata: {
              final: true,
              retryCount: newRetryCount,
              timestamp: new Date().toISOString()
            }
          });
          
          await message.ack(); // Remove from queue
        }
      }
    }
    
    // Close database connection
    await client.end();
  },
};

async function processSyncOperation(
  db: any, 
  recordId: number, 
  operation: string, 
  data: any
): Promise<void> {
  
  switch (operation) {
    case 'INSERT':
    case 'UPDATE':
      // Validate data - don't crash worker on invalid data
      if (!data || typeof data !== 'object') {
        throw new Error(`Invalid data format for record ${recordId}: data is ${typeof data}`);
      }
      
      // Check for required fields
      if (!data.id || !data.name || !data.email) {
        throw new Error(`Missing required fields for record ${recordId}`);
      }
      
      // Sanitize data - remove any circular references or non-serializable values
      const sanitizedData = JSON.parse(JSON.stringify(data));
      
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
            syncStatus: 'synced',
          })
          .where(eq(studentSnapshots.studentId, recordId));
          
        console.log(`Updated snapshot for record ${recordId}`);
      } else {
        // Insert new snapshot
        await db.insert(studentSnapshots).values({
          studentId: recordId,
          data: sanitizedData,
          syncStatus: 'synced',
        });
        
        console.log(`Created snapshot for record ${recordId}`);
      }
      break;
      
    case 'DELETE':
      // For DELETE, update the snapshot to mark as deleted
      // We don't actually delete it for audit purposes
      await db
        .update(studentSnapshots)
        .set({
          data: null,
          syncStatus: 'deleted',
          lastSyncedAt: new Date(),
        })
        .where(eq(studentSnapshots.studentId, recordId));
      
      console.log(`Marked record ${recordId} as deleted`);
      break;
      
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

// Helper function to validate data
function validateData(data: any): boolean {
  // Check for circular references
  try {
    JSON.stringify(data);
    return true;
  } catch {
    return false;
  }
}