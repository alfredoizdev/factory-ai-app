ALTER TABLE "projects" ADD COLUMN "ask_mode" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "paths" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "stop_for_me" boolean DEFAULT false NOT NULL;