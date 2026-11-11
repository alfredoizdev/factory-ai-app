ALTER TABLE `projects` ADD `repo_path` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `test_command` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `worktree_path` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `base_commit` text;