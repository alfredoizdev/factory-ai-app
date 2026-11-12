ALTER TABLE "questions" ADD COLUMN "consumed_at" text;--> statement-breakpoint
UPDATE "questions" SET "consumed_at" = "answered_at" WHERE "state" = 'answered';
