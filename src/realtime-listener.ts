import { RealtimeClient, REALTIME_POSTGRES_CHANGES_LISTEN_EVENT } from '@supabase/realtime-js';

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

// Custom WebSocket adapter for Cloudflare Workers
class CFWebSocketAdapter {
  private ws: WebSocket;
  public onopen: (() => void) | null = null;
  public onclose: ((event: any) => void) | null = null;
  public onerror: ((event: any) => void) | null = null;
  public onmessage: ((event: any) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    // CRITICAL: Never pass empty protocols array
    const finalProtocols = protocols && protocols.length > 0 ? protocols : undefined;
    
    // @ts-ignore - Cloudflare Workers WebSocket constructor
    this.ws = new WebSocket(url, finalProtocols);
    
    this.ws.addEventListener('open', () => {
      console.log('🔌 WebSocket connection opened');
      if (this.onopen) this.onopen();
    });
    
    this.ws.addEventListener('close', (event) => {
      console.log('🔌 WebSocket connection closed:', event.code, event.reason);
      if (this.onclose) this.onclose(event);
    });
    
    this.ws.addEventListener('error', (event) => {
      console.error('🔌 WebSocket error:', event);
      if (this.onerror) this.onerror(event);
    });
    
    this.ws.addEventListener('message', (event) => {
      if (this.onmessage) this.onmessage(event);
    });
  }

  send(data: any) {
    this.ws.send(data);
  }

  close(code?: number, reason?: string) {
    this.ws.close(code, reason);
  }
}

let client: RealtimeClient | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

export async function startRealtimeListener(env: Env) {
  // Close existing client if any
  if (client) {
    console.log('🔄 Disconnecting existing Realtime client...');
    client.disconnect();
    client = null;
  }

  console.log('🔌 Starting Supabase Realtime listener...');
  
  try {
    // Construct the Realtime URL
    const realtimeUrl = env.SUPABASE_URL.replace('https', 'wss') + '/realtime/v1';
    console.log('📡 Realtime URL:', realtimeUrl);
    
    // Create the realtime client
    client = new RealtimeClient(realtimeUrl, {
      params: {
        apikey: env.SUPABASE_ANON_KEY,
      },
      // @ts-ignore - Custom WebSocket transport
      transport: CFWebSocketAdapter,
      heartbeatIntervalMs: 15000,
    });

    // Set up connection handler - RealtimeClient uses a different API
    // We need to check connection status through the channels
    
    // Connect to Realtime
    client.connect();

    // Create a channel for students table
    const channel = client.channel('realtime:public:students');

    // Subscribe to INSERT events
    channel.on(
      'postgres_changes',
      { 
        event: REALTIME_POSTGRES_CHANGES_LISTEN_EVENT.INSERT, 
        schema: 'public', 
        table: 'students' 
      },
      async (payload: any) => {
        console.log('📝 INSERT detected:', payload.new?.id);
        if (payload.new) {
          await queueSync(env, {
            recordId: payload.new.id,
            operation: 'INSERT',
            data: payload.new,
            timestamp: new Date().toISOString(),
            retryCount: 0
          });
        }
      }
    );

    // Subscribe to UPDATE events
    channel.on(
      'postgres_changes',
      { 
        event: REALTIME_POSTGRES_CHANGES_LISTEN_EVENT.UPDATE, 
        schema: 'public', 
        table: 'students' 
      },
      async (payload: any) => {
        console.log('📝 UPDATE detected:', payload.new?.id);
        if (payload.new) {
          await queueSync(env, {
            recordId: payload.new.id,
            operation: 'UPDATE',
            data: payload.new,
            timestamp: new Date().toISOString(),
            retryCount: 0
          });
        }
      }
    );

    // Subscribe to DELETE events
    channel.on(
      'postgres_changes',
      { 
        event: REALTIME_POSTGRES_CHANGES_LISTEN_EVENT.DELETE, 
        schema: 'public', 
        table: 'students' 
      },
      async (payload: any) => {
        console.log('📝 DELETE detected:', payload.old?.id);
        if (payload.old) {
          await queueSync(env, {
            recordId: payload.old.id,
            operation: 'DELETE',
            data: payload.old,
            timestamp: new Date().toISOString(),
            retryCount: 0
          });
        }
      }
    );

    // Subscribe to the channel
    channel.subscribe((status: string, err?: Error) => {
      console.log('📡 Channel subscription status:', status);
      
      if (status === 'SUBSCRIBED') {
        console.log('✅ Successfully subscribed to students table changes!');
        reconnectAttempts = 0;
      } else if (status === 'CHANNEL_ERROR') {
        console.error('❌ Channel error:', err?.message || 'Unknown error');
        
        // Exponential backoff for reconnection
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
          reconnectAttempts++;
          console.log(`⏰ Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          
          setTimeout(() => {
            channel.subscribe();
          }, delay);
        }
      } else if (status === 'TIMED_OUT') {
        console.error('❌ Subscription timed out');
        setTimeout(() => channel.subscribe(), 5000);
      } else if (status === 'CLOSED') {
        console.log('📡 Channel closed');
      }
    });

    // Log client connection status through channel events
    console.log('✅ Realtime client setup complete');

    return client;

  } catch (error) {
    console.error('❌ Failed to start Realtime listener:', error);
    throw error;
  }
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