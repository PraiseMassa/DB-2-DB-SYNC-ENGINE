import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { students } from './db/schema';
import * as dotenv from 'dotenv';

dotenv.config();

const FIRST_NAMES = ['John', 'Ella', 'Favour', 'Kate', 'Didi', 'Beatrice', 'Ethan', 'Caleb', 'Jane', 'Michael', 'Sarah', 'David', 'Emma', 'James', 'Lisa', 'Robert', 'Maria'];
const LAST_NAMES = ['Smith', 'Ambrose', 'Reed', 'Robbins', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
const COURSES = ['Computer Science', 'Sotfware', 'Mathematics', 'Physics', 'Chemistry', 'Biology', 'Engineering', 'Economics', 'Psychology', 'English', 'History'];

function generateRandomStudent(index: number) {
  const firstName = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  const timestamp = Date.now() + index;
  
  return {
    name: `${firstName} ${lastName}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${timestamp}@example.com`,
    age: Math.floor(Math.random() * 30) + 18, // 18-48
    course: COURSES[Math.floor(Math.random() * COURSES.length)],
  };
}

async function seedStudents() {
  const connectionString = process.env.DATABASE_URL;
  
  if (!connectionString) {
    console.error('❌ DATABASE_URL not set in .env file');
    return;
  }
  
  console.log('🔌 Connecting to database...');
  const client = postgres(connectionString);
  const db = drizzle(client);
  
  try {
    console.log('🌱 Starting to seed 200 students...');
    
    const studentsToInsert = [];
    for (let i = 0; i < 200; i++) {
      studentsToInsert.push(generateRandomStudent(i));
    }
    
    // Insert in batches of 50 for better performance
    const batchSize = 50;
    let inserted = 0;
    
    for (let i = 0; i < studentsToInsert.length; i += batchSize) {
      const batch = studentsToInsert.slice(i, i + batchSize);
      const result = await db.insert(students).values(batch).returning({ id: students.id });
      inserted += result.length;
      console.log(`✅ Inserted batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(studentsToInsert.length/batchSize)} (${inserted}/${studentsToInsert.length} students)`);
    }
    
    console.log('🎉 Successfully seeded 200 students!');
    console.log('📊 Summary:');
    console.log(`   - Total students inserted: ${inserted}`);
    console.log(`   - Time: ${new Date().toLocaleTimeString()}`);
    
    // Show a few sample emails
    const sample = await db.select().from(students).limit(5);
    console.log('\n📝 Sample of inserted students:');
    sample.forEach(s => {
      console.log(`   - ${s.name} (${s.email}) - ${s.course}`);
    });
    
  } catch (error) {
    console.error('❌ Error seeding students:', error);
  } finally {
    await client.end();
    console.log('🔌 Database connection closed');
  }
}

// Run the seed function
seedStudents().catch(console.error);