CREATE TABLE "student_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"data" jsonb NOT NULL,
	"last_synced_at" timestamp DEFAULT now() NOT NULL,
	"sync_status" text DEFAULT 'pending',
	CONSTRAINT "student_snapshots_student_id_unique" UNIQUE("student_id")
);
--> statement-breakpoint
CREATE TABLE "students" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"age" integer,
	"course" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "students_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "sync_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"record_id" integer NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"error_details" text,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb
);
