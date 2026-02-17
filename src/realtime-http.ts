import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SYNC_QUEUE: Queue;
}

interface StudentRecord {
  id: number;
  name: string;
  email: string;
  age: number | null;
  course: string | null;
  created_at: string;
  updated_at: string;
}

interface SnapshotRecord {
  student_id: number;
}

let lastCheckTimestamp = 0;
let isPolling = false;

export async function startRealtimeListener(env: Env) {
  console.log('🔌 Starting HTTP-based Realtime listener...');
  
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  
  // Start polling for changes every 5 seconds
  if (!isPolling) {
    isPolling = true;
    // Don't await - let it run in background
    pollForChanges(env, supabase).catch((error: Error) => {
      console.error('❌ Fatal polling error:', error);
      isPolling = false;
    });
  }
  
  return { status: 'polling started' };
}

export async function manualPoll(env: Env) {
  console.log('🔄 Manual poll triggered');
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  await pollForChanges(env, supabase);
}

export async function pollForChanges(env: Env, supabase: SupabaseClient) {
  console.log('🔄 Polling for changes...');
  
  try {
    // Test connection
    const { data: testData, error: testError } = await supabase
      .from('students')
      .select('id')
      .limit(1);

    if (testError) {
      console.error('❌ Supabase connection test failed:', testError);
      setTimeout(() => pollForChanges(env, supabase), 10000);
      return;
    }
    
    console.log('✅ Supabase connection successful');
    
    // For first run or manual poll, get all students that don't have snapshots
    if (lastCheckTimestamp === 0) {
      console.log('🔍 First run - checking all students');
      
      // Get all students
      const { data: allStudents, error: allError } = await supabase
        .from('students')
        .select('*');
      
      if (allError) {
        console.error('❌ Error fetching all students:', allError);
      } else if (allStudents) {
        console.log(`📊 Total students in DB: ${allStudents.length}`);
        
        // Get existing snapshots
        const { data: snapshots, error: snapError } = await supabase
          .from('student_snapshots')
          .select('student_id');
        
        if (snapError) {
          console.error('❌ Error fetching snapshots:', snapError);
        } else if (snapshots) {
          const snapshotIds = new Set(snapshots.map((s: SnapshotRecord) => s.student_id));
          
          // Find students without snapshots
          const studentsWithoutSnapshots = allStudents.filter((s: StudentRecord) => !snapshotIds.has(s.id));
          
          if (studentsWithoutSnapshots.length > 0) {
            console.log(`📝 Found ${studentsWithoutSnapshots.length} students without snapshots`);
            
            for (const record of studentsWithoutSnapshots) {
              console.log(`🔔 Processing student ${record.id}: ${record.name}`);
              
              await queueSync(env, {
                recordId: record.id,
                operation: 'INSERT',
                data: record,
                timestamp: new Date().toISOString(),
                retryCount: 0
              });
            }
          } else {
            console.log('📭 All students have snapshots');
          }
        }
      }
    } else {
      // Normal polling - get students updated since last check
      console.log(`🔍 Checking for changes since ${new Date(lastCheckTimestamp).toISOString()}`);
      
      const { data, error } = await supabase
        .from('students')
        .select('*')
        .gte('updated_at', new Date(lastCheckTimestamp - 1000).toISOString());
      
      if (error) {
        console.error('❌ Polling query error:', error);
      } else if (data && data.length > 0) {
        console.log(`📝 Found ${data.length} changes`);
        
        for (const record of data) {
          if (!record.id) continue;
          
          console.log(`🔔 Processing student ${record.id}: ${record.name}`);
          
          await queueSync(env, {
            recordId: record.id,
            operation: 'INSERT',
            data: record,
            timestamp: new Date().toISOString(),
            retryCount: 0
          });
        }
      } else {
        console.log('📭 No changes found');
      }
    }
    
    // Update last check timestamp
    lastCheckTimestamp = Date.now();
    console.log(`✅ Polling complete. Next check in 5 seconds`);
    
  } catch (error) {
    console.error('❌ Polling error:', error);
  }
  
  // Schedule next poll
  setTimeout(() => pollForChanges(env, supabase), 5000);
}

async function queueSync(env: Env, message: any) {
  try {
    await env.SYNC_QUEUE.send(message, {
      contentType: 'json',
    });
    console.log(`📤 Queued ${message.operation} for record ${message.recordId}`);
  } catch (error) {
    console.error('❌ Failed to queue message:', error);
  }
}