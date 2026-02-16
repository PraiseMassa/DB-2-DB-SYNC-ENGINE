import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

async function testRealtime() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );
  
  console.log('Testing Realtime connection...');
  
  const channel = supabase
    .channel('test-' + Date.now())
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'students' },
      (payload) => {
        console.log('✅ Received change!', payload);
      }
    )
    .subscribe((status) => {
      console.log('Status:', status);
      if (status === 'SUBSCRIBED') {
        console.log('✅ Realtime is working! Now insert a student...');
      }
    });
  
  // Keep running for 30 seconds
  await new Promise(resolve => setTimeout(resolve, 30000));
  channel.unsubscribe();
}

testRealtime();