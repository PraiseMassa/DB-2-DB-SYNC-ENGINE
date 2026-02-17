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
  data: any;
  syncStatus: string;
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
    const { error: testError } = await supabase
      .from('students')
      .select('id')
      .limit(1);

    if (testError) {
      console.error('❌ Supabase connection test failed:', testError);
      setTimeout(() => pollForChanges(env, supabase), 10000);
      return;
    }
    
    console.log('✅ Supabase connection successful');
    
    // Get all students
    const { data: allStudents, error: allError } = await supabase
      .from('students')
      .select('*');
    
    if (allError) {
      console.error('❌ Error fetching all students:', allError);
      setTimeout(() => pollForChanges(env, supabase), 5000);
      return;
    }
    
    // Get all snapshots
    const { data: allSnapshots, error: snapError } = await supabase
      .from('student_snapshots')
      .select('*');
    
    if (snapError) {
      console.error('❌ Error fetching snapshots:', snapError);
      setTimeout(() => pollForChanges(env, supabase), 5000);
      return;
    }
    
    console.log(`📊 Students: ${allStudents.length}, Snapshots: ${allSnapshots?.length || 0}`);
    
    // Create maps for easy lookup
    const studentMap = new Map(allStudents.map(s => [s.id, s]));
    const snapshotMap = new Map(allSnapshots?.map(s => [s.student_id, s]) || []);
    
    // 1. Check for INSERTs (students without snapshots)
    const studentsWithoutSnapshots = allStudents.filter(s => !snapshotMap.has(s.id));
    
    if (studentsWithoutSnapshots.length > 0) {
      console.log(`📝 Found ${studentsWithoutSnapshots.length} students to INSERT`);
      
      for (const record of studentsWithoutSnapshots) {
        console.log(`🔔 INSERT student ${record.id}: ${record.name}`);
        await queueSync(env, {
          recordId: record.id,
          operation: 'INSERT',
          data: record,
          timestamp: new Date().toISOString(),
          retryCount: 0
        });
      }
    }
    
    // 2. Check for UPDATEs (students with modified data)
    const studentsWithSnapshots = allStudents.filter(s => snapshotMap.has(s.id));
    const updatesToProcess = [];
    
    for (const student of studentsWithSnapshots) {
      const snapshot = snapshotMap.get(student.id);
      if (snapshot && JSON.stringify(snapshot.data) !== JSON.stringify(student)) {
        updatesToProcess.push(student);
      }
    }
    
    if (updatesToProcess.length > 0) {
      console.log(`📝 Found ${updatesToProcess.length} students to UPDATE`);
      
      for (const record of updatesToProcess) {
        console.log(`🔔 UPDATE student ${record.id}: ${record.name}`);
        await queueSync(env, {
          recordId: record.id,
          operation: 'UPDATE',
          data: record,
          timestamp: new Date().toISOString(),
          retryCount: 0
        });
      }
    }
    
    // 3. Check for DELETEs (snapshots without students)
const orphanedSnapshots = allSnapshots?.filter(s => !studentMap.has(s.student_id)) || [];

if (orphanedSnapshots.length > 0) {
  console.log(`🗑️ Found ${orphanedSnapshots.length} students to DELETE`);
  
  for (const snapshot of orphanedSnapshots) {
    console.log(`🔔 DELETE student ${snapshot.student_id}`);
    console.log('Sending DELETE message with data:', null);
    await queueSync(env, {
      recordId: snapshot.student_id,
      operation: 'DELETE',
      data: null,  // CHANGED: Send null instead of an object
      timestamp: new Date().toISOString(),
      retryCount: 0
    });
  }
}
    
    if (studentsWithoutSnapshots.length === 0 && updatesToProcess.length === 0 && orphanedSnapshots.length === 0) {
      console.log('📭 No changes detected');
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