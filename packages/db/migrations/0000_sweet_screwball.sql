CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"message" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_task_id" uuid,
	"agent_name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"request" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"max_delivery_attempts" integer DEFAULT 3 NOT NULL,
	"dead_letter" boolean DEFAULT false NOT NULL,
	"idempotency_key" text,
	"checkpoint" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_task_events_task_stream" ON "task_events" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "ix_tasks_claim" ON "tasks" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_tasks_idempotency_key" ON "tasks" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ix_tasks_lease_expires_at" ON "tasks" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "ix_tasks_parent_task_id" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_created_at" ON "tasks" USING btree ("created_at");