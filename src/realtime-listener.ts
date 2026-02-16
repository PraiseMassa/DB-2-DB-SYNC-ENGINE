import { createClient, RealtimeChannel } from '@supabase/supabase-js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SYNC_QUEUE: Queue;
}

export interface DatabaseChange {
  id: number;
  name: string;
  email: string;
  age: number | null;
  course: string | null;
  created_at: string;
  updated_at: string;
}

let currentChannel: RealtimeChannel | null = null;

export async function startRealtimeListener(env: Env) {
  // Close existing channel if any
  if (currentChannel) {
    console.log('🔄 Closing existing Realtime channel...');
    await currentChannel.unsubscribe();
    currentChannel = null;
  }

  // Create Supabase client with service role for full access
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  
  console.log('🔌 Starting Realtime listener for students table...');
  console.log('📋 Configuration:', {
    url: env.SUPABASE_URL,
    hasServiceKey: !!env.SUPABASE_SERVICE_ROLE_KEY,
  });
  
  // Subscribe to changes on the students table
  const channel = supabase
    .channel('students-changes', {
      config: {
        broadcast: { self: true },
        presence: { key: '' },
        private: false,
      },
    })
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'students',
      },
      async (payload) => {
        console.log('📝 INSERT detected:', payload.new.id);
        await queueSync(env, {
          recordId: payload.new.id,
          operation: 'INSERT',
          data: payload.new,
          timestamp: new Date().toISOString(),
          retryCount: 0
        });
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'students',
      },
      async (payload) => {
        console.log('📝 UPDATE detected:', payload.new.id);
        await queueSync(env, {
          recordId: payload.new.id,
          operation: 'UPDATE',
          data: payload.new,
          timestamp: new Date().toISOString(),
          retryCount: 0
        });
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'students',
      },
      async (payload) => {
        console.log('📝 DELETE detected:', payload.old.id);
        await queueSync(env, {
          recordId: payload.old.id,
          operation: 'DELETE',
          data: payload.old,
          timestamp: new Date().toISOString(),
          retryCount: 0
        });
      }
    )
    .subscribe((status, err) => {
      console.log('Realtime subscription status:', status);
      
      if (status === 'SUBSCRIBED') {
        console.log('✅ Successfully subscribed to students table changes!');
        currentChannel = channel;
      } else if (status === 'CHANNEL_ERROR') {
        console.error('❌ CHANNEL_ERROR - This usually means:');
        console.error('   1. Realtime is not enabled on the students table');
        console.error('   2. The API key is invalid or missing permissions');
        console.error('   3. RLS policies are blocking access');
        console.error('   4. The channel name might be in use');
        if (err) console.error('Error details:', err);
        
        // Retry after 5 seconds
        console.log('⏰ Will retry in 5 seconds...');
        setTimeout(() => startRealtimeListener(env), 5000);
      } else if (status === 'TIMED_OUT') {
        console.error('❌ Subscription timed out - retrying in 5 seconds...');
        setTimeout(() => startRealtimeListener(env), 5000);
      } else if (status === 'CLOSED') {
        console.log('📡 Channel closed - will reopen if needed');
      }
    });
  
  return channel;
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