@'

# DB-to-DB Sync Engine with JSONB

A robust data synchronization system that keeps two PostgreSQL databases in sync using Cloudflare Workers, Queues, and Supabase.

## Project Overview

This system automatically syncs data from a normalized `students` table to a `student_snapshots` table with JSONB storage. It handles full CRUD operations with reliable queue-based processing and exponential backoff retries.

## Architecture

### Components

- **Source Database**: Supabase PostgreSQL with normalized `students` table
- **Target Database**: Supabase PostgreSQL with `student_snapshots` (JSONB column)
- **Change Detection**: HTTP polling (5-second intervals)
- **Sync Worker**: Cloudflare Worker (Hono) processing sync operations
- **Queue System**: Cloudflare Queue with exponential backoff retries
- **Logging**: Comprehensive `sync_logs` table for auditing

### Tech Stack

| Layer     | Technology          |
| --------- | ------------------- |
| Runtime   | Cloudflare Workers  |
| Framework | Hono                |
| Database  | Supabase PostgreSQL |
| ORM       | Drizzle             |
| Queue     | Cloudflare Queues   |
| Language  | TypeScript          |

## Features

- **Full CRUD Support**: INSERT, UPDATE, DELETE operations sync automatically
- **JSONB Storage**: Source data transformed to JSONB documents
- **Reliable Queue Processing**: Cloudflare Queues with 3 retry attempts
- **Exponential Backoff**: Retry delays: 5s, 10s, 20s
- **Error Handling**: Graceful failure handling with detailed logging
- **Reconciliation**: Endpoint to detect and fix out-of-sync records
- **Load Tested**: Successfully processed 205 records with 0 failures

## Quick Start

## Prerequisites

- Node.js 18+
- Cloudflare Account
- Supabase Account
- Wrangler CLI (`npm install -g wrangler`)

## Install dependencies

npm install

1. **Clone the repository**

```bash
git clone https://github.com/yourusername/db-sync-engine.git
cd db-sync-engine
```

## Set up environment variables

Create .dev.vars file:

SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_ANON_KEY=your-anon-key \
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
DATABASE_URL=postgresql://postgres.your-project:password@pooler.supabase.com:5432/postgres \
WORKER_DATABASE_URL=postgresql://postgres.your-project:password@pooler.supabase.com:6543/postgres?pgbouncer=true

## Run database migrations

npm run db:generate \
npm run db:migrate

## Start the worker locally

npm run dev

## Queue Retry Logic

Exponential backoff: 5s, 10s, 20s \
const delaySeconds = Math.pow(2, retryCount) \* 5;

### API Endpoints

| Method | Endpoint                     | Description                       |
| ------ | ---------------------------- | --------------------------------- |
| GET    | /                            | Health check                      |
| POST   | /api/sync/backfill           | Sync all existing students        |
| GET    | /api/sync/status/:studentId? | Get sync status                   |
| GET    | /api/sync/logs               | View sync logs                    |
| POST   | /api/sync/reconcile          | Find out-of-sync records          |
| POST   | /api/sync/retry-failed       | Retry failed records              |
| POST   | /api/sync/poll               | Manually trigger change detection |

### How It Works

Change Detection Flow
Polling: Every 5 seconds, the worker queries both tables \
Comparison: Compares source data with target JSONB snapshots \
Missing snapshots → Queue INSERT \
Data mismatch → Queue UPDATE \
Orphaned snapshots → Queue DELETE \
Queue: Changes are sent to Cloudflare Queue \
Processing: Queue consumer processes with retry logic \
Storage: Data stored as JSONB in target database \
Logging: All operations recorded in sync_logs

## Load Test Results

Successfully processed 205 records with: \
100% INSERT success rate \
0 retries needed \
0 failures \
Average latency: ~5 seconds \
See LOAD_TEST_REPORT.md for detailed results.

## Testing

# Check health

curl http://localhost:8787/

# Insert test student

curl -X POST http://localhost:8787/api/test/insert-raw \
 -H "Content-Type: application/json" \
 -d '{"name":"Test User","email":"test@example.com","age":25,"course":"Testing"}'

# Check sync status

curl http://localhost:8787/api/sync/logs \
 curl http://localhost:8787/api/sync/status

### Deployment

# Deploy to Cloudflare Workers

npm run deploy

# Set production secrets

npx wrangler secret put SUPABASE_URL \
 npx wrangler secret put SUPABASE_ANON_KEY \
 npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY \
 npx wrangler secret put DATABASE_URL \
 npx wrangler secret put WORKER_DATABASE_URL

### Project Structure

db-sync-engine/

- src/
- - index.ts # Main worker with API endpoints
- - realtime-http.ts # Polling logic
- - queue-worker.ts # Queue handler
- - db/
- - - schema.ts # Database schema
- - seed-students.ts # Load test script
- .dev.vars # Local environment variables
- .gitignore # Git ignore file
- wrangler.toml # Cloudflare configuration
- package.json # Dependencies
- tsconfig.json # TypeScript configuration
- README.md # This file
- LOAD_TEST_REPORT.md # Load test results
- drizzle.config.ts # Drizzle ORM config

### Key Learnings

- WebSocket Limitations: Cloudflare Workers have WebSocket limitations, solved with HTTP polling
- NOT NULL Constraints: Soft deletes require nullable JSONB columns
- Queue Reliability: Exponential backoff ensures reliable processing
- Error Handling: Comprehensive logging and retry logic

## Issues Encountered & Resolved

| Issue                               | Resolution                                   |
| ----------------------------------- | -------------------------------------------- |
| WebSocket connection errors         | Switched to HTTP polling                     |
| Invalid API keys                    | Updated with correct Supabase credentials    |
| NOT NULL constraint on JSONB column | Altered table to allow NULL for soft deletes |
| DELETE query failures               | Fixed with raw SQL and constraint removal    |

## Acceptance Criteria Checklist

- Insert in DB1 → appears in DB2 within seconds
- Updates in DB1 reflected in DB2
- Deletes in DB1 reflected in DB2 (soft delete)
- Failed syncs retry via Cloudflare Queue with backoff
- Invalid data logged and skipped gracefully
- Sync log table shows full operation history
- Back-fill migrates all existing data
- 200-record load test completed successfully

## Conclusion

**LOAD TEST RESULT: PASSED**

The DB Sync Engine successfully handles 205 records with 100% success rate and meets all project requirements.
