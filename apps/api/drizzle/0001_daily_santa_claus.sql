CREATE TABLE `app_env_vars` (
	`app_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_env_vars_key_unique` ON `app_env_vars` (`app_id`,`key`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`app_id` text PRIMARY KEY NOT NULL,
	`port` integer,
	`health_path` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`hostname` text NOT NULL,
	`active_deployment_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apps_slug_unique` ON `apps` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `apps_hostname_unique` ON `apps` (`hostname`);--> statement-breakpoint
CREATE TABLE `deployment_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`deployment_id` text NOT NULL,
	`app_id` text NOT NULL,
	`status` text NOT NULL,
	`claimed_by` text,
	`claimed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deployment_commands_status_created_idx` ON `deployment_commands` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `deployment_commands_deployment_id_idx` ON `deployment_commands` (`deployment_id`);--> statement-breakpoint
CREATE TABLE `deployment_env_snapshots` (
	`deployment_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_env_snapshots_key_unique` ON `deployment_env_snapshots` (`deployment_id`,`key`);--> statement-breakpoint
CREATE TABLE `deployment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_events_sequence_unique` ON `deployment_events` (`deployment_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `deployment_events_deployment_id_idx` ON `deployment_events` (`deployment_id`);--> statement-breakpoint
CREATE TABLE `deployment_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`phase` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_logs_sequence_unique` ON `deployment_logs` (`deployment_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `deployment_logs_deployment_id_idx` ON `deployment_logs` (`deployment_id`);--> statement-breakpoint
CREATE TABLE `deployment_option_snapshots` (
	`deployment_id` text PRIMARY KEY NOT NULL,
	`options_json` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_json` text NOT NULL,
	`status` text NOT NULL,
	`image_tag` text,
	`live_url` text,
	`container_id` text,
	`rollback_source_deployment_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deployments_app_id_idx` ON `deployments` (`app_id`);--> statement-breakpoint
CREATE INDEX `deployments_status_idx` ON `deployments` (`status`);--> statement-breakpoint
CREATE INDEX `deployments_created_at_idx` ON `deployments` (`created_at`);--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`published_at` text
);
--> statement-breakpoint
CREATE INDEX `outbox_events_status_created_idx` ON `outbox_events` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
