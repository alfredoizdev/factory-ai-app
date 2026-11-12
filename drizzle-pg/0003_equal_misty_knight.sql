ALTER TABLE "project_notes" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "project_notes" ADD COLUMN "kind" text DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_notes" ADD COLUMN "paths" text;--> statement-breakpoint
ALTER TABLE "project_notes" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "project_notes" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "register_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_notes_number_idx" ON "project_notes" USING btree ("project_id","number");--> statement-breakpoint
UPDATE "project_notes" SET "number" = n.rn FROM (SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "created_at", "id") AS rn FROM "project_notes") n WHERE "project_notes"."id" = n."id";--> statement-breakpoint
UPDATE "projects" SET "register_seq" = m.top FROM (SELECT "project_id", max("number") AS top FROM "project_notes" GROUP BY "project_id") m WHERE "projects"."id" = m."project_id";
