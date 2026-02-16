import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './db/schema';

async function testConnection() {
  try {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL not set');
    }
    
    const client = postgres(connectionString);
    const db = drizzle(client, { schema });
    
    console.log('✅ Database connection successful');
    
    // Test query
    const result = await db.select().from(schema.students).limit(1);
    console.log('✅ Query test successful');
    
    await client.end();
  } catch (error) {
    console.error('❌ Database connection failed:', error);
  }
}

testConnection();