CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"node_run_id" text NOT NULL,
	"finding_id" text,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"why" text NOT NULL,
	"options_json" text NOT NULL,
	"recommended" text,
	"touches_json" text NOT NULL,
	"state" text NOT NULL,
	"answer_option" text,
	"answer_text" text,
	"actor" text,
	"answered_at" text,
	"delivered_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_node_run_id_node_runs_id_fk" FOREIGN KEY ("node_run_id") REFERENCES "public"."node_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questions_run_idx" ON "questions" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_asked_once" ON "questions" USING btree ("run_id","node_run_id","kind",coalesce("finding_id", ''));