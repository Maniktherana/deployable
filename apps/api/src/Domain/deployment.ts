import { Schema } from "effect";

export const AppId = Schema.String.pipe(Schema.brand("AppId"));
export type AppId = typeof AppId.Type;

export const DeploymentId = Schema.String.pipe(Schema.brand("DeploymentId"));
export type DeploymentId = typeof DeploymentId.Type;

export const DeploymentStatus = Schema.Literals([
  "pending",
  "building",
  "deploying",
  "running",
  "stopped",
  "failed",
]);
export type DeploymentStatus = typeof DeploymentStatus.Type;

export const DeploymentKind = Schema.Literals(["build", "rollback"]);
export type DeploymentKind = typeof DeploymentKind.Type;

export const GitRefKind = Schema.Literals(["branch", "tag"]);
export type GitRefKind = typeof GitRefKind.Type;

export const DeploymentSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("git"),
    url: Schema.String,
    ref: Schema.optional(Schema.String),
    refKind: Schema.optional(GitRefKind),
    commitSha: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("upload"),
    filename: Schema.String,
    rootDirectory: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("rollback"),
    sourceDeploymentId: DeploymentId,
  }),
]);
export type DeploymentSource = typeof DeploymentSource.Type;

export const App = Schema.Struct({
  id: AppId,
  name: Schema.String,
  slug: Schema.String,
  hostname: Schema.String,
  activeDeploymentId: Schema.optional(DeploymentId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type App = typeof App.Type;

export const Deployment = Schema.Struct({
  id: DeploymentId,
  appId: AppId,
  kind: DeploymentKind,
  source: DeploymentSource,
  status: DeploymentStatus,
  imageTag: Schema.optional(Schema.String),
  liveUrl: Schema.optional(Schema.String),
  containerId: Schema.optional(Schema.String),
  rollbackSourceDeploymentId: Schema.optional(DeploymentId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Deployment = typeof Deployment.Type;

export const DeploymentLogLevel = Schema.Literals(["info", "warn", "error"]);
export type DeploymentLogLevel = typeof DeploymentLogLevel.Type;

export const DeploymentLogPhase = Schema.Literals(["prepare", "build", "deploy", "runtime"]);
export type DeploymentLogPhase = typeof DeploymentLogPhase.Type;

export const DeploymentLogEvent = Schema.Struct({
  deploymentId: DeploymentId,
  sequence: Schema.Number,
  phase: DeploymentLogPhase,
  level: DeploymentLogLevel,
  message: Schema.String,
  createdAt: Schema.String,
});
export type DeploymentLogEvent = typeof DeploymentLogEvent.Type;

export const EnvVarMap = Schema.Record(Schema.String, Schema.String);
export type EnvVarMap = typeof EnvVarMap.Type;

// Build configuration overrides surfaced in the deploy form / project
// settings. Both fields map directly to the railpack `--build-cmd` and
// `--start-cmd` flags. Empty / undefined means "let railpack auto-detect".
export const BuildConfig = Schema.Struct({
  buildCommand: Schema.optional(Schema.String),
  startCommand: Schema.optional(Schema.String),
});
export type BuildConfig = typeof BuildConfig.Type;

export const CreateDeploymentInput = Schema.Union([
  Schema.Struct({
    sourceType: Schema.Literal("git"),
    gitUrl: Schema.String,
    ref: Schema.optional(Schema.String),
    refKind: Schema.optional(GitRefKind),
    appId: Schema.optional(AppId),
    appName: Schema.optional(Schema.String),
    envVars: Schema.optional(EnvVarMap),
    buildCommand: Schema.optional(Schema.String),
    startCommand: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    sourceType: Schema.Literal("upload"),
    filename: Schema.String,
    rootDirectory: Schema.optional(Schema.String),
    appId: Schema.optional(AppId),
    appName: Schema.optional(Schema.String),
    envVars: Schema.optional(EnvVarMap),
    buildCommand: Schema.optional(Schema.String),
    startCommand: Schema.optional(Schema.String),
  }),
]);
export type CreateDeploymentInput = typeof CreateDeploymentInput.Type;

export const RailpackPreflightResult = Schema.Struct({
  detectedProvider: Schema.optional(Schema.String),
  buildCommand: Schema.optional(Schema.String),
  startCommand: Schema.optional(Schema.String),
});
export type RailpackPreflightResult = typeof RailpackPreflightResult.Type;
