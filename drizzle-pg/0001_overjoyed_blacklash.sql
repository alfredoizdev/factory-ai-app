CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_machines" (
	"project_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"repo_path" text,
	"base_status" text DEFAULT 'none' NOT NULL,
	"base_commit" text,
	"base_lock_hash" text,
	"base_message" text,
	"base_updated_at" text,
	CONSTRAINT "project_machines_project_id_machine_id_pk" PRIMARY KEY("project_id","machine_id")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "delivered_at" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "delivered_at" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "machine_id" text;--> statement-breakpoint
ALTER TABLE "project_machines" ADD CONSTRAINT "project_machines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;