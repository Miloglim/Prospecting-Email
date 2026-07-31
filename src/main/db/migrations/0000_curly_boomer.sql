CREATE TABLE `email_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`provider` text DEFAULT 'smtp' NOT NULL,
	`smtp_host` text,
	`smtp_port` integer,
	`imap_host` text,
	`imap_port` integer,
	`encrypted_pass` text NOT NULL,
	`display_name` text,
	`signature` text,
	`consecutive_fails` integer DEFAULT 0 NOT NULL,
	`circuit_open_at` text,
	`circuit_reset_after` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_accounts_email_unique` ON `email_accounts` (`email`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`domain` text,
	`industry` text,
	`country` text,
	`size` text,
	`backcheck_data` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`title` text,
	`phone` text,
	`linkedin_url` text,
	`company_id` integer,
	`custom_str1` text,
	`custom_str2` text,
	`custom_str3` text,
	`custom_str4` text,
	`custom_str5` text,
	`custom_num1` integer,
	`custom_num2` integer,
	`custom_num3` integer,
	`custom_num4` integer,
	`custom_num5` integer,
	`custom_date1` text,
	`custom_date2` text,
	`custom_date3` text,
	`custom_date4` text,
	`custom_date5` text,
	`source` text DEFAULT 'manual',
	`source_detail` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_unique` ON `contacts` (`email`);--> statement-breakpoint
CREATE TABLE `crm_relations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_id_a` integer NOT NULL,
	`contact_id_b` integer NOT NULL,
	`relation_type` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contact_id_a`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id_b`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `crm_stages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_id` integer NOT NULL,
	`stage` text NOT NULL,
	`notes` text,
	`reminder_at` text,
	`reminder_note` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crm_stages_contact_id_unique` ON `crm_stages` (`contact_id`);--> statement-breakpoint
CREATE TABLE `inbox_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`message_id` text,
	`from_email` text NOT NULL,
	`from_name` text,
	`subject` text,
	`body_preview` text,
	`classification` text,
	`matched_contact_id` integer,
	`is_read` integer DEFAULT 0 NOT NULL,
	`received_at` text NOT NULL,
	`raw_source` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `email_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_id` integer NOT NULL,
	`type` text NOT NULL,
	`direction` text NOT NULL,
	`channel` text DEFAULT 'email' NOT NULL,
	`subject` text,
	`body_preview` text,
	`message_id` text,
	`account_id` integer,
	`metadata` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `email_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`language` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`category` text,
	`version` integer DEFAULT 1 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
