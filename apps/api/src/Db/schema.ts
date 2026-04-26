import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const apps = sqliteTable(
  "apps",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    hostname: text("hostname").notNull(),
    activeDeploymentId: text("active_deployment_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("apps_slug_unique").on(table.slug),
    uniqueIndex("apps_hostname_unique").on(table.hostname),
  ],
);

export const deployments = sqliteTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    kind: text("kind", { enum: ["build", "rollback"] }).notNull(),
    sourceJson: text("source_json").notNull(),
    status: text("status", {
      enum: ["pending", "building", "deploying", "running", "stopped", "failed"],
    }).notNull(),
    imageTag: text("image_tag"),
    liveUrl: text("live_url"),
    containerId: text("container_id"),
    rollbackSourceDeploymentId: text("rollback_source_deployment_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("deployments_app_id_idx").on(table.appId),
    index("deployments_status_idx").on(table.status),
    index("deployments_created_at_idx").on(table.createdAt),
  ],
);

export const deploymentEvents = sqliteTable(
  "deployment_events",
  {
    id: text("id").primaryKey(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("deployment_events_sequence_unique").on(table.deploymentId, table.sequence),
    index("deployment_events_deployment_id_idx").on(table.deploymentId),
  ],
);

export const deploymentLogs = sqliteTable(
  "deployment_logs",
  {
    id: text("id").primaryKey(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id),
    sequence: integer("sequence").notNull(),
    phase: text("phase", {
      enum: ["prepare", "build", "deploy", "runtime"],
    }).notNull(),
    level: text("level", { enum: ["info", "warn", "error"] }).notNull(),
    message: text("message").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("deployment_logs_sequence_unique").on(table.deploymentId, table.sequence),
    index("deployment_logs_deployment_id_idx").on(table.deploymentId),
  ],
);

export const deploymentCommands = sqliteTable(
  "deployment_commands",
  {
    id: text("id").primaryKey(),
    type: text("type", { enum: ["deploy", "rollback"] }).notNull(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed"],
    }).notNull(),
    claimedBy: text("claimed_by"),
    claimedAt: text("claimed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("deployment_commands_status_created_idx").on(table.status, table.createdAt),
    index("deployment_commands_deployment_id_idx").on(table.deploymentId),
  ],
);

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    topic: text("topic").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status", {
      enum: ["pending", "published", "failed"],
    }).notNull(),
    createdAt: text("created_at").notNull(),
    publishedAt: text("published_at"),
  },
  (table) => [index("outbox_events_status_created_idx").on(table.status, table.createdAt)],
);

export const appEnvVars = sqliteTable(
  "app_env_vars",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("app_env_vars_key_unique").on(table.appId, table.key)],
);

export const deploymentEnvSnapshots = sqliteTable(
  "deployment_env_snapshots",
  {
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (table) => [uniqueIndex("deployment_env_snapshots_key_unique").on(table.deploymentId, table.key)],
);

export const appSettings = sqliteTable("app_settings", {
  appId: text("app_id")
    .primaryKey()
    .references(() => apps.id),
  port: integer("port"),
  healthPath: text("health_path"),
  // Railpack overrides surfaced in the deploy form / project settings. Both
  // map 1:1 to the `--build-cmd` / `--start-cmd` flags. NULL means "let
  // railpack auto-detect from the project".
  buildCommand: text("build_command"),
  startCommand: text("start_command"),
  updatedAt: text("updated_at").notNull(),
});

export const deploymentOptionSnapshots = sqliteTable("deployment_option_snapshots", {
  deploymentId: text("deployment_id")
    .primaryKey()
    .references(() => deployments.id),
  optionsJson: text("options_json").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type AppRow = InferSelectModel<typeof apps>;
export type NewAppRow = InferInsertModel<typeof apps>;
export type DeploymentRow = InferSelectModel<typeof deployments>;
export type NewDeploymentRow = InferInsertModel<typeof deployments>;
export type DeploymentEventRow = InferSelectModel<typeof deploymentEvents>;
export type NewDeploymentEventRow = InferInsertModel<typeof deploymentEvents>;
export type DeploymentLogRow = InferSelectModel<typeof deploymentLogs>;
export type NewDeploymentLogRow = InferInsertModel<typeof deploymentLogs>;
export type DeploymentCommandRow = InferSelectModel<typeof deploymentCommands>;
export type NewDeploymentCommandRow = InferInsertModel<typeof deploymentCommands>;
export type OutboxEventRow = InferSelectModel<typeof outboxEvents>;
export type NewOutboxEventRow = InferInsertModel<typeof outboxEvents>;
export type SettingRow = InferSelectModel<typeof settings>;
export type NewSettingRow = InferInsertModel<typeof settings>;
