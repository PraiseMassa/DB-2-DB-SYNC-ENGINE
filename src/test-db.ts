import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

async function testConnection() {
  const connectionString = process.env.DATABASE_URL;
  
  if (!connectionString) {
    console.error('❌ DATABASE_URL not set in .env file');
    return;
  }
  
  try {
    const client = postgres(connectionString);
    const db = drizzle(client);
    
    // Test query
    const result = await client`SELECT NOW() as time`;
    console.log('✅ Database connection successful!');
    console.log('📅 Server time:', result[0].time);
    
    await client.end();
  } catch (error) {
    console.error('❌ Connection failed:', error);
  }
}

testConnection();