import { createClient, RealtimeChannel } from '@supabase/supabase-js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SYNC_QUEUE: Queue;
}

// Cloudflare-compatible WebSocket
class CloudflareWebSocket {
  private ws: WebSocket;
  
  constructor(url: string, protocols?: string | string[]) {
    // Critical: Don't pass empty protocols array
    const finalProtocols = protocols && protocols.length > 0 ? protocols : undefined;
    
    // @ts-ignore - Cloudflare's WebSocket expects different signature
    this.ws = new WebSocket(url, finalProtocols);
    
    // Bind event handlers
    this.ws.addEventListener('message', (event) => {
      if (this.onmessage) this.onmessage(event);
    });
    
    this.ws.addEventListener('open', () => {
      if (this.onopen) this.onopen();
    });
    
    this.ws.addEventListener('close', (event) => {
      if (this.onclose) this.onclose(event);
    });
    
    this.ws.addEventListener('error', (event) => {
      if (this.onerror) this.onerror(event);
    });
  }
  
  onopen: (() => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  
  send(data: any) {
    this.ws.send(data);
  }
  
  close(code?: number, reason?: string) {
    this.ws.close(code, reason);
  }
}

let currentChannel: RealtimeChannel | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

export async function startRealtimeListener(env: Env) {
  // Close existing channel if any
  if (currentChannel) {
    console.log('🔄 Closing existing Realtime channel...');
    await currentChannel.unsubscribe();
    currentChannel = null;
  }

  console.log('🔌 Starting Realtime listener for students table...');
  
  try {
    // Create Supabase client with custom WebSocket
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
        // @ts-ignore - Custom WebSocket transport
        transport: CloudflareWebSocket,
      }
    });
    
    // Create a unique channel name
    const channelName = `students-changes-${Date.now()}`;
    
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'students',
        },
        async (payload: any) => {
          console.log(`📝 ${payload.eventType} detected! ID:`, payload.new?.id || payload.old?.id);
          
          try {
            const recordId = payload.new?.id || payload.old?.id;
            const operation = payload.eventType === 'INSERT' ? 'INSERT' : 
                            payload.eventType === 'UPDATE' ? 'UPDATE' : 'DELETE';
            const data = payload.new || payload.old;
            
            await env.SYNC_QUEUE.send({
              recordId,
              operation,
              data,
              timestamp: new Date().toISOString(),
              retryCount: 0
            });
            
            console.log(`📤 Queued ${operation} for record ${recordId}`);
            reconnectAttempts = 0;
            
          } catch (err) {
            console.error('❌ Error processing change:', err);
          }
        }
      )
      .subscribe((status) => {
        console.log('📡 Realtime status:', status);
        
        if (status === 'SUBSCRIBED') {
          console.log('✅ SUCCESS! Listening to students table changes');
          currentChannel = channel;
          reconnectAttempts = 0;
        } else if (status === 'CHANNEL_ERROR') {
          console.error('❌ Channel error (expected, retrying...)');
          
          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            reconnectAttempts++;
            console.log(`⏰ Retry ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
            
            setTimeout(() => {
              channel.unsubscribe();
              startRealtimeListener(env);
            }, delay);
          }
        }
      });
    
    return channel;
    
  } catch (error) {
    console.error('❌ Failed to start Realtime listener:', error);
    throw error;
  }
}