CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"round" integer NOT NULL,
	"type" text NOT NULL,
	"file" text,
	"line" integer,
	"problem" text NOT NULL,
	"severity" text NOT NULL,
	"affects_json" text NOT NULL,
	"decisions_json" text NOT NULL,
	"reporters_json" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"repro_json" text,
	"evidence_json" text,
	"entry_number" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findings_run_idx" ON "findings" USING btree ("run_id");