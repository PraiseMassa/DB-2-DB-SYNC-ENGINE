import postgres from 'postgres';

const sql = postgres('postgresql://postgres.ereosgahrj1qwobxhymd:Man21SSA.yes@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true');

try {
  const result = await sql`SELECT NOW() as time`;
  console.log('✅ Connection successful:', result);
} catch (error) {
  console.error('❌ Connection failed:', error);
} finally {
  await sql.end();
}