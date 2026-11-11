ALTER TABLE `projects` ADD `base_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `base_commit` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `base_lock_hash` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `base_message` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `base_updated_at` text;