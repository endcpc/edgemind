ALTER TABLE "runs" ADD COLUMN "partial" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "rescue_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "rescued_at" timestamp with time zone;