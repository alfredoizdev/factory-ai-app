ALTER TABLE `runs` ADD `title` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `title_by_person` integer DEFAULT false NOT NULL;