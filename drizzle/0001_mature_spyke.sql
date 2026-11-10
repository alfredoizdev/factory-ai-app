PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`version_id` text NOT NULL,
	`status` text NOT NULL,
	`request` text NOT NULL,
	`provider_id` text NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`) REFERENCES `workflow_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "project_id", "workflow_id", "version_id", "status", "request", "provider_id", "created_at", "started_at", "finished_at") SELECT "id", "project_id", "workflow_id", "version_id", "status", "request", "provider_id", "created_at", "started_at", "finished_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `runs_workflow_idx` ON `runs` (`workflow_id`);