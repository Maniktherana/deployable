import {
  type App,
  type AppId,
  AppId as AppIdSchema,
  type BuildConfig,
  type CreateDeploymentInput,
  type Deployment,
  type DeploymentId,
  type DeploymentLogEvent,
  type DeploymentLogLevel,
  type DeploymentLogPhase,
  type DeploymentSource,
  type DeploymentStatus,
  DeploymentId as DeploymentIdSchema,
} from "../Domain/deployment.ts";
import { asc, count, desc, eq, max } from "drizzle-orm";
import { Context, Data, Effect, Layer, PubSub, Schema, Stream } from "effect";

import { DatabaseService } from "../Db/Database.ts";
import {
  appEnvVars,
  apps,
  appSettings,
  deploymentCommands,
  deploymentEnvSnapshots,
  deploymentEvents,
  deploymentLogs,
  deploymentOptionSnapshots,
  deployments,
  type DeploymentCommandRow,
  type DeploymentLogRow,
  type DeploymentRow,
  outboxEvents,
  settings,
} from "../Db/schema.ts";
import { CaddyService } from "./CaddyService.ts";
import { DockerService } from "./DockerService.ts";
import { RedisService } from "./RedisService.ts";

export class DeploymentNotFoundError extends Data.TaggedError("DeploymentNotFoundError")<{
  readonly deploymentId: string;
}> {}

export class AppNotFoundError extends Data.TaggedError("AppNotFoundError")<{
  readonly appId: string;
}> {}

export class CommandEnqueueError extends Data.TaggedError("CommandEnqueueError")<{
  readonly message: string;
}> {}

export type DeploymentServiceError =
  | DeploymentNotFoundError
  | AppNotFoundError
  | CommandEnqueueError;

export interface DeploymentCommand {
  readonly id: string;
  readonly type: "deploy" | "rollback";
  readonly deploymentId: DeploymentId;
  readonly appId: string;
  readonly status: "pending" | "running" | "succeeded" | "failed";
}

export interface DeploymentServiceShape {
  readonly createDeployment: (
    input: CreateDeploymentInput,
  ) => Effect.Effect<Deployment, DeploymentServiceError>;
  readonly rollbackDeployment: (input: {
    readonly appId: AppId;
    readonly targetDeploymentId: DeploymentId;
  }) => Effect.Effect<Deployment, DeploymentServiceError>;
  readonly redeployDeployment: (input: {
    readonly appId: AppId;
    readonly sourceDeploymentId: DeploymentId;
  }) => Effect.Effect<Deployment, DeploymentServiceError>;
  readonly listDeployments: Effect.Effect<ReadonlyArray<Deployment>, never>;
  readonly listDeploymentsByApp: (appId: AppId) => Effect.Effect<ReadonlyArray<Deployment>, never>;
  readonly getDeployment: (
    deploymentId: DeploymentId,
  ) => Effect.Effect<Deployment, DeploymentServiceError>;
  readonly getApp: (appId: AppId) => Effect.Effect<App, DeploymentServiceError>;
  readonly listApps: Effect.Effect<ReadonlyArray<App>, never>;
  readonly updateApp: (input: {
    readonly appId: AppId;
    readonly name?: string;
    readonly hostname?: string;
  }) => Effect.Effect<App, DeploymentServiceError>;
  readonly deleteApp: (appId: AppId) => Effect.Effect<void, DeploymentServiceError>;
  readonly stopApp: (appId: AppId) => Effect.Effect<App, DeploymentServiceError>;
  readonly restartApp: (input: {
    readonly appId: AppId;
    readonly deploymentId: DeploymentId;
  }) => Effect.Effect<App, DeploymentServiceError>;
  readonly listAppEnv: (
    appId: AppId,
  ) => Effect.Effect<Record<string, string>, DeploymentServiceError>;
  readonly setAppEnv: (input: {
    readonly appId: AppId;
    readonly envVars: Record<string, string>;
  }) => Effect.Effect<Record<string, string>, DeploymentServiceError>;
  readonly getAppBuildConfig: (appId: AppId) => Effect.Effect<BuildConfig, DeploymentServiceError>;
  readonly setAppBuildConfig: (input: {
    readonly appId: AppId;
    readonly buildCommand?: string;
    readonly startCommand?: string;
  }) => Effect.Effect<BuildConfig, DeploymentServiceError>;
  readonly streamLogs: (
    deploymentId: DeploymentId,
  ) => Stream.Stream<DeploymentLogEvent, DeploymentServiceError>;
  readonly appendLog: (event: DeploymentLogEvent) => Effect.Effect<void>;
  readonly appendLogLine: (input: {
    readonly deploymentId: DeploymentId;
    readonly phase: DeploymentLogPhase;
    readonly level: DeploymentLogLevel;
    readonly message: string;
  }) => Effect.Effect<void>;
  readonly updateStatus: (input: {
    readonly deploymentId: DeploymentId;
    readonly status: DeploymentStatus;
    readonly imageTag?: string;
    readonly liveUrl?: string;
    readonly containerId?: string;
  }) => Effect.Effect<Deployment, DeploymentServiceError>;
  readonly claimNextCommand: (workerId: string) => Effect.Effect<DeploymentCommand | undefined>;
  readonly completeCommand: (commandId: string) => Effect.Effect<void>;
  readonly failCommand: (input: {
    readonly commandId: string;
    readonly reason: string;
  }) => Effect.Effect<void>;
}

export class DeploymentService extends Context.Service<DeploymentService, DeploymentServiceShape>()(
  "@deployable/api/Services/DeploymentService",
) {}

function nowIso(): string {
  return new Date().toISOString();
}

const DEPLOYMENT_CONCURRENCY_KEY = "deployment.concurrency";

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function makeDeploymentId(): DeploymentId {
  return Schema.decodeSync(DeploymentIdSchema)(makeId("dep"));
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "");
  return slug.length > 0 ? slug : "app";
}

function nameFromGitUrl(url: string): string {
  const withoutTrailingSlash = url.replaceAll(/\/+$/g, "");
  const lastSegment = withoutTrailingSlash.split("/").at(-1) ?? "app";
  return lastSegment.replaceAll(/\.git$/g, "") || "app";
}

function sourceFromInput(input: CreateDeploymentInput): DeploymentSource {
  if (input.sourceType === "git") {
    return {
      type: "git",
      url: input.gitUrl,
      ref: input.ref,
      refKind: input.refKind,
    };
  }
  return {
    type: "upload",
    filename: input.filename,
    rootDirectory: input.rootDirectory,
  };
}

function mapDeployment(row: DeploymentRow): Deployment {
  const source = JSON.parse(row.sourceJson) as DeploymentSource;
  return {
    id: Schema.decodeSync(DeploymentIdSchema)(row.id),
    appId: row.appId as AppId,
    kind: row.kind,
    source,
    status: row.status,
    imageTag: row.imageTag ?? undefined,
    liveUrl: row.liveUrl ?? undefined,
    containerId: row.containerId ?? undefined,
    rollbackSourceDeploymentId:
      row.rollbackSourceDeploymentId === null
        ? undefined
        : Schema.decodeSync(DeploymentIdSchema)(row.rollbackSourceDeploymentId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapLog(row: DeploymentLogRow): DeploymentLogEvent {
  return {
    deploymentId: Schema.decodeSync(DeploymentIdSchema)(row.deploymentId),
    sequence: row.sequence,
    phase: row.phase,
    level: row.level,
    message: row.message,
    createdAt: row.createdAt,
  };
}

function mapCommand(row: DeploymentCommandRow): DeploymentCommand {
  return {
    id: row.id,
    type: row.type,
    deploymentId: Schema.decodeSync(DeploymentIdSchema)(row.deploymentId),
    appId: row.appId,
    status: row.status,
  };
}

function mapApp(row: typeof apps.$inferSelect): App {
  return {
    id: Schema.decodeSync(AppIdSchema)(row.id),
    name: row.name,
    slug: row.slug,
    hostname: row.hostname,
    activeDeploymentId: row.activeDeploymentId
      ? Schema.decodeSync(DeploymentIdSchema)(row.activeDeploymentId)
      : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const DeploymentServiceLive = Layer.effect(
  DeploymentService,
  Effect.gen(function* () {
    const { db } = yield* DatabaseService;
    const redis = yield* RedisService;
    const docker = yield* DockerService;
    const caddy = yield* CaddyService;
    const logPubSub = yield* PubSub.unbounded<DeploymentLogEvent>();

    const readDeploymentConcurrency = () => {
      const row = db.query.settings
        .findFirst({ where: eq(settings.key, DEPLOYMENT_CONCURRENCY_KEY) })
        .sync();
      if (!row) {
        return 1;
      }
      const parsed = JSON.parse(row.valueJson) as unknown;
      return typeof parsed === "number" ? Math.min(16, Math.max(1, parsed)) : 1;
    };

    const getDeployment: DeploymentServiceShape["getDeployment"] = (deploymentId) =>
      Effect.sync(() => {
        const row = db.query.deployments
          .findFirst({
            where: eq(deployments.id, deploymentId),
          })
          .sync();
        if (!row) {
          throw new DeploymentNotFoundError({ deploymentId });
        }
        return mapDeployment(row);
      });

    const appendLog: DeploymentServiceShape["appendLog"] = (event) =>
      Effect.sync(() => {
        db.transaction((tx) => {
          tx.insert(deploymentLogs)
            .values({
              id: makeId("log"),
              deploymentId: event.deploymentId,
              sequence: event.sequence,
              phase: event.phase,
              level: event.level,
              message: event.message,
              createdAt: event.createdAt,
            })
            .run();
          tx.insert(outboxEvents)
            .values({
              id: makeId("outbox"),
              topic: "deployment.logs.appended",
              payloadJson: JSON.stringify({
                deploymentId: event.deploymentId,
                sequence: event.sequence,
              }),
              status: "pending",
              createdAt: nowIso(),
            })
            .run();
        });
      }).pipe(Effect.andThen(PubSub.publish(logPubSub, event)), Effect.asVoid);

    const nextLogSequence = (deploymentId: DeploymentId): number => {
      const row = db
        .select({ value: max(deploymentLogs.sequence) })
        .from(deploymentLogs)
        .where(eq(deploymentLogs.deploymentId, deploymentId))
        .get();
      return (row?.value ?? 0) + 1;
    };

    const appendLogLine: DeploymentServiceShape["appendLogLine"] = (input) =>
      appendLog({
        deploymentId: input.deploymentId,
        sequence: nextLogSequence(input.deploymentId),
        phase: input.phase,
        level: input.level,
        message: input.message,
        createdAt: nowIso(),
      });

    const updateStatus: DeploymentServiceShape["updateStatus"] = (input) =>
      getDeployment(input.deploymentId).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            const timestamp = nowIso();
            db.update(deployments)
              .set({
                status: input.status,
                imageTag: input.imageTag,
                // Only persist liveUrl when the deployment is actually running
                liveUrl: input.status === "running" ? (input.liveUrl ?? null) : null,
                containerId: input.containerId,
                updatedAt: timestamp,
              })
              .where(eq(deployments.id, input.deploymentId))
              .run();
            return mapDeployment(
              db.query.deployments
                .findFirst({
                  where: eq(deployments.id, input.deploymentId),
                })
                .sync()!,
            );
          }),
        ),
      );

    const svc: DeploymentServiceShape = {
      createDeployment: (input) =>
        Effect.gen(function* () {
          const timestamp = nowIso();
          const deploymentId = makeDeploymentId();
          const source = sourceFromInput(input);

          const created = yield* Effect.sync(() =>
            db.transaction((tx) => {
              const app = (() => {
                if (input.appId) {
                  const existing = tx.query.apps
                    .findFirst({ where: eq(apps.id, input.appId) })
                    .sync();
                  if (!existing) {
                    throw new AppNotFoundError({ appId: input.appId });
                  }
                  return existing;
                }

                const name =
                  input.appName ??
                  (input.sourceType === "git"
                    ? nameFromGitUrl(input.gitUrl)
                    : (input.rootDirectory ?? input.filename));
                const baseSlug = slugify(name);
                let slug = baseSlug;
                while (tx.query.apps.findFirst({ where: eq(apps.slug, slug) }).sync()) {
                  slug = `${baseSlug}-${crypto.randomUUID().slice(0, 6)}`;
                }

                const createdApp = {
                  id: makeId("app"),
                  name,
                  slug,
                  hostname: `${slug}.localhost:8080`,
                  activeDeploymentId: null,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                } satisfies typeof apps.$inferInsert;
                tx.insert(apps).values(createdApp).run();
                return createdApp;
              })();

              tx.insert(deployments)
                .values({
                  id: deploymentId,
                  appId: app.id,
                  kind: "build",
                  sourceJson: JSON.stringify(source),
                  status: "pending",
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
                .run();
              if (input.envVars) {
                tx.delete(appEnvVars).where(eq(appEnvVars.appId, app.id)).run();
                for (const key of Object.keys(input.envVars)) {
                  if (!key) continue;
                  const value = (input.envVars as Record<string, string>)[key]!;
                  tx.insert(appEnvVars)
                    .values({ appId: app.id, key, value, updatedAt: timestamp })
                    .run();
                }
              }
              // Persist build/start command overrides into app_settings so the
              // worker can read them later when running railpack. We only touch
              // these columns when the caller explicitly provided a value
              // (including an empty string -> "clear it"), leaving any other
              // settings (port, healthPath) intact.
              if (input.buildCommand !== undefined || input.startCommand !== undefined) {
                const existing = tx.query.appSettings
                  .findFirst({ where: eq(appSettings.appId, app.id) })
                  .sync();
                const buildCommand =
                  input.buildCommand !== undefined
                    ? input.buildCommand.trim() || null
                    : (existing?.buildCommand ?? null);
                const startCommand =
                  input.startCommand !== undefined
                    ? input.startCommand.trim() || null
                    : (existing?.startCommand ?? null);
                if (existing) {
                  tx.update(appSettings)
                    .set({ buildCommand, startCommand, updatedAt: timestamp })
                    .where(eq(appSettings.appId, app.id))
                    .run();
                } else {
                  tx.insert(appSettings)
                    .values({
                      appId: app.id,
                      port: null,
                      healthPath: null,
                      buildCommand,
                      startCommand,
                      updatedAt: timestamp,
                    })
                    .run();
                }
              }
              tx.insert(deploymentEvents)
                .values({
                  id: makeId("evt"),
                  deploymentId,
                  sequence: 1,
                  type: "deployment.created",
                  payloadJson: JSON.stringify({
                    appId: app.id,
                    sourceType: input.sourceType,
                  }),
                  createdAt: timestamp,
                })
                .run();
              tx.insert(outboxEvents)
                .values({
                  id: makeId("outbox"),
                  topic: "deployment.events.appended",
                  payloadJson: JSON.stringify({ deploymentId, sequence: 1 }),
                  status: "pending",
                  createdAt: timestamp,
                })
                .run();
              const commandId = makeId("cmd");
              tx.insert(deploymentCommands)
                .values({
                  id: commandId,
                  type: "deploy",
                  deploymentId,
                  appId: app.id,
                  status: "pending",
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
                .run();

              return {
                commandId,
                deployment: mapDeployment(
                  tx.query.deployments
                    .findFirst({
                      where: eq(deployments.id, deploymentId),
                    })
                    .sync()!,
                ),
              };
            }),
          );

          yield* appendLogLine({
            deploymentId: created.deployment.id,
            phase: "prepare",
            level: "info",
            message: "Deployment created and queued.",
          });

          yield* redis.publishCommandWakeup(created.commandId).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* updateStatus({
                  deploymentId: created.deployment.id,
                  status: "failed",
                });
                yield* Effect.sync(() => {
                  db.update(deploymentCommands)
                    .set({
                      status: "failed",
                      updatedAt: nowIso(),
                    })
                    .where(eq(deploymentCommands.id, created.commandId))
                    .run();
                });
                yield* appendLogLine({
                  deploymentId: created.deployment.id,
                  phase: "prepare",
                  level: "error",
                  message: `Failed to enqueue deployment command: ${error instanceof Error ? error.message : String(error)}`,
                });
                return yield* Effect.fail(
                  new CommandEnqueueError({
                    message: error instanceof Error ? error.message : String(error),
                  }),
                );
              }),
            ),
          );

          return created.deployment;
        }),
      rollbackDeployment: ({ appId, targetDeploymentId }) =>
        Effect.gen(function* () {
          const timestamp = nowIso();
          const target = yield* getDeployment(targetDeploymentId);

          if (target.appId !== appId) {
            return yield* Effect.fail(
              new DeploymentNotFoundError({ deploymentId: targetDeploymentId }),
            );
          }
          if (!target.imageTag) {
            return yield* Effect.fail(
              new CommandEnqueueError({
                message: `Deployment ${targetDeploymentId} has no image to rollback to`,
              }),
            );
          }

          const deploymentId = makeDeploymentId();
          const source: DeploymentSource = {
            type: "rollback",
            sourceDeploymentId: targetDeploymentId,
          };

          const created = yield* Effect.sync(() =>
            db.transaction((tx) => {
              tx.insert(deployments)
                .values({
                  id: deploymentId,
                  appId,
                  kind: "rollback",
                  sourceJson: JSON.stringify(source),
                  status: "pending",
                  imageTag: target.imageTag!,
                  rollbackSourceDeploymentId: targetDeploymentId,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
                .run();
              tx.insert(deploymentEvents)
                .values({
                  id: makeId("evt"),
                  deploymentId,
                  sequence: 1,
                  type: "deployment.rollback.created",
                  payloadJson: JSON.stringify({
                    appId,
                    sourceDeploymentId: targetDeploymentId,
                  }),
                  createdAt: timestamp,
                })
                .run();
              tx.insert(outboxEvents)
                .values({
                  id: makeId("outbox"),
                  topic: "deployment.events.appended",
                  payloadJson: JSON.stringify({ deploymentId, sequence: 1 }),
                  status: "pending",
                  createdAt: timestamp,
                })
                .run();
              const commandId = makeId("cmd");
              tx.insert(deploymentCommands)
                .values({
                  id: commandId,
                  type: "rollback",
                  deploymentId,
                  appId,
                  status: "pending",
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
                .run();
              return {
                commandId,
                deployment: mapDeployment(
                  tx.query.deployments
                    .findFirst({ where: eq(deployments.id, deploymentId) })
                    .sync()!,
                ),
              };
            }),
          );

          yield* appendLogLine({
            deploymentId: created.deployment.id,
            phase: "prepare",
            level: "info",
            message: `Rollback deployment created from ${targetDeploymentId} (image: ${target.imageTag}).`,
          });

          yield* redis.publishCommandWakeup(created.commandId).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* updateStatus({
                  deploymentId: created.deployment.id,
                  status: "failed",
                });
                yield* Effect.fail(
                  new CommandEnqueueError({
                    message: error instanceof Error ? error.message : String(error),
                  }),
                );
              }),
            ),
          );

          return created.deployment;
        }),
      redeployDeployment: ({ appId, sourceDeploymentId }) =>
        Effect.gen(function* () {
          const source = yield* getDeployment(sourceDeploymentId);

          if (source.appId !== appId) {
            return yield* Effect.fail(
              new DeploymentNotFoundError({ deploymentId: sourceDeploymentId }),
            );
          }

          // Walk back through rollback chains to find the original build source.
          let buildSource = source;
          while (buildSource.source.type === "rollback" && buildSource.rollbackSourceDeploymentId) {
            buildSource = yield* getDeployment(buildSource.rollbackSourceDeploymentId);
          }

          if (buildSource.source.type === "rollback" || buildSource.source.type === "upload") {
            if (buildSource.source.type === "upload") {
              return yield* Effect.fail(
                new CommandEnqueueError({
                  message: `Cannot redeploy an upload-based deployment (no stored archive).`,
                }),
              );
            }
            return yield* Effect.fail(
              new CommandEnqueueError({
                message: `Could not resolve original build source for redeploy.`,
              }),
            );
          }

          const gitSource = buildSource.source as {
            type: "git";
            url: string;
            ref?: string;
            refKind?: "branch" | "tag";
          };

          return yield* svc.createDeployment({
            sourceType: "git",
            appId,
            gitUrl: gitSource.url,
            ref: gitSource.ref,
            refKind: gitSource.refKind,
          });
        }),
      listDeployments: Effect.sync(() =>
        db.query.deployments
          .findMany({ orderBy: [desc(deployments.createdAt)] })
          .sync()
          .map(mapDeployment),
      ),
      listDeploymentsByApp: (appId) =>
        Effect.sync(() =>
          db.query.deployments
            .findMany({
              where: eq(deployments.appId, appId),
              orderBy: [desc(deployments.createdAt)],
            })
            .sync()
            .map(mapDeployment),
        ),
      getDeployment,
      getApp: (appId) =>
        Effect.sync(() => {
          const row = db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync();
          if (!row) throw new AppNotFoundError({ appId });
          return mapApp(row);
        }),
      listApps: Effect.sync(() =>
        db.query.apps
          .findMany({ orderBy: [desc(apps.createdAt)] })
          .sync()
          .map(mapApp),
      ),
      updateApp: ({ appId, name, hostname }) =>
        Effect.sync(() => {
          const row = db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync();
          if (!row) throw new AppNotFoundError({ appId });
          const updates: Partial<typeof apps.$inferInsert> = {
            updatedAt: nowIso(),
          };
          if (name !== undefined) updates.name = name;
          if (hostname !== undefined) updates.hostname = hostname;
          db.update(apps).set(updates).where(eq(apps.id, appId)).run();
          return mapApp(db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync()!);
        }),
      listAppEnv: (appId) =>
        Effect.gen(function* () {
          const exists = yield* Effect.sync(() =>
            db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync(),
          );
          if (!exists) {
            return yield* Effect.fail(new AppNotFoundError({ appId }));
          }
          return yield* Effect.sync(() => {
            const rows = db
              .select({ key: appEnvVars.key, value: appEnvVars.value })
              .from(appEnvVars)
              .where(eq(appEnvVars.appId, appId))
              .all();
            const out: Record<string, string> = {};
            for (const r of rows) out[r.key] = r.value;
            return out;
          });
        }),
      setAppEnv: ({ appId, envVars }) =>
        Effect.gen(function* () {
          const exists = yield* Effect.sync(() =>
            db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync(),
          );
          if (!exists) {
            return yield* Effect.fail(new AppNotFoundError({ appId }));
          }
          return yield* Effect.sync(() => {
            const timestamp = nowIso();
            db.transaction((tx) => {
              tx.delete(appEnvVars).where(eq(appEnvVars.appId, appId)).run();
              for (const [key, value] of Object.entries(envVars)) {
                if (!key) continue;
                tx.insert(appEnvVars).values({ appId, key, value, updatedAt: timestamp }).run();
              }
            });
            const rows = db
              .select({ key: appEnvVars.key, value: appEnvVars.value })
              .from(appEnvVars)
              .where(eq(appEnvVars.appId, appId))
              .all();
            const out: Record<string, string> = {};
            for (const r of rows) out[r.key] = r.value;
            return out;
          });
        }),
      getAppBuildConfig: (appId) =>
        Effect.gen(function* () {
          const exists = yield* Effect.sync(() =>
            db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync(),
          );
          if (!exists) {
            return yield* Effect.fail(new AppNotFoundError({ appId }));
          }
          return yield* Effect.sync(() => {
            const row = db
              .select({
                buildCommand: appSettings.buildCommand,
                startCommand: appSettings.startCommand,
              })
              .from(appSettings)
              .where(eq(appSettings.appId, appId))
              .get();
            return {
              buildCommand: row?.buildCommand ?? undefined,
              startCommand: row?.startCommand ?? undefined,
            } satisfies BuildConfig;
          });
        }),
      setAppBuildConfig: ({ appId, buildCommand, startCommand }) =>
        Effect.gen(function* () {
          const exists = yield* Effect.sync(() =>
            db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync(),
          );
          if (!exists) {
            return yield* Effect.fail(new AppNotFoundError({ appId }));
          }
          return yield* Effect.sync(() => {
            const timestamp = nowIso();
            const existing = db
              .select()
              .from(appSettings)
              .where(eq(appSettings.appId, appId))
              .get();
            // Treat undefined as "do not change", empty string as "clear".
            const nextBuild =
              buildCommand !== undefined
                ? buildCommand.trim() || null
                : (existing?.buildCommand ?? null);
            const nextStart =
              startCommand !== undefined
                ? startCommand.trim() || null
                : (existing?.startCommand ?? null);
            if (existing) {
              db.update(appSettings)
                .set({
                  buildCommand: nextBuild,
                  startCommand: nextStart,
                  updatedAt: timestamp,
                })
                .where(eq(appSettings.appId, appId))
                .run();
            } else {
              db.insert(appSettings)
                .values({
                  appId,
                  port: null,
                  healthPath: null,
                  buildCommand: nextBuild,
                  startCommand: nextStart,
                  updatedAt: timestamp,
                })
                .run();
            }
            return {
              buildCommand: nextBuild ?? undefined,
              startCommand: nextStart ?? undefined,
            } satisfies BuildConfig;
          });
        }),
      stopApp: (appId) =>
        Effect.gen(function* () {
          const row = yield* Effect.sync(() =>
            db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync(),
          );
          if (!row) {
            return yield* Effect.fail(new AppNotFoundError({ appId }));
          }
          const activeId = row.activeDeploymentId;
          if (activeId) {
            const dep = db.select().from(deployments).where(eq(deployments.id, activeId)).get();
            if (dep?.containerId) {
              yield* docker.stopContainer(dep.containerId).pipe(Effect.catch(() => Effect.void));
              yield* docker.removeContainer(dep.containerId).pipe(Effect.catch(() => Effect.void));
            }
            yield* caddy
              .removeRoute(row.hostname.replace(/:.*$/, ""))
              .pipe(Effect.catch(() => Effect.void));
            yield* Effect.sync(() => {
              const ts = nowIso();
              if (dep) {
                db.update(deployments)
                  .set({ status: "stopped", updatedAt: ts })
                  .where(eq(deployments.id, activeId))
                  .run();
              }
              db.update(apps)
                .set({ activeDeploymentId: null, updatedAt: ts })
                .where(eq(apps.id, appId))
                .run();
            });
            yield* appendLogLine({
              deploymentId: Schema.decodeSync(DeploymentIdSchema)(activeId),
              phase: "runtime",
              level: "info",
              message: "Deployment stopped via API.",
            });
          }
          return mapApp(db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync()!);
        }),
      restartApp: ({ appId, deploymentId }) =>
        Effect.gen(function* () {
          const app = yield* Effect.sync(() =>
            db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync(),
          );
          if (!app) return yield* Effect.fail(new AppNotFoundError({ appId }));

          const dep = yield* getDeployment(deploymentId);
          if (dep.appId !== appId)
            return yield* Effect.fail(new DeploymentNotFoundError({ deploymentId }));
          if (!dep.imageTag)
            return yield* Effect.fail(
              new CommandEnqueueError({ message: "Deployment has no built image to restart." }),
            );

          const ts = nowIso();
          const containerName = `deployable-${app.slug}-${deploymentId}`;
          const settings = db
            .select()
            .from(appSettings)
            .where(eq(appSettings.appId, appId))
            .get();
          const appPort = settings?.port ?? 3000;

          // Start a fresh container from the existing image. Same env shape
          // as the deploy worker: user vars + PORT (railpack-generated
          // entrypoints listen on $PORT).
          const envVars = yield* Effect.sync(() => {
            const rows = db.select().from(appEnvVars).where(eq(appEnvVars.appId, appId)).all();
            const map = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<
              string,
              string
            >;
            map.PORT = String(appPort);
            return map;
          });
          const container = yield* docker
            .runContainer({
              imageTag: dep.imageTag,
              name: containerName,
              envVars,
              network: "deployable",
              labels: {
                "deployable.app": appId,
                "deployable.deployment": deploymentId,
                "deployable.slug": app.slug,
              },
            })
            .pipe(Effect.mapError((e) => new CommandEnqueueError({ message: e.message })));

          const hostname = app.hostname.replace(/:.*$/, "");
          const upstream = `${containerName}:${appPort}`;
          yield* caddy.addRoute({ hostname, upstream }).pipe(Effect.catch(() => Effect.void));

          const liveUrl = `http://${app.hostname}`;
          yield* Effect.sync(() => {
            db.update(deployments)
              .set({
                status: "running",
                containerId: container.containerId,
                liveUrl,
                updatedAt: ts,
              })
              .where(eq(deployments.id, deploymentId))
              .run();
            db.update(apps)
              .set({ activeDeploymentId: deploymentId, updatedAt: ts })
              .where(eq(apps.id, appId))
              .run();
          });

          yield* appendLogLine({
            deploymentId,
            phase: "runtime",
            level: "info",
            message: "Deployment restarted via API.",
          });

          return mapApp(db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync()!);
        }),
      deleteApp: (appId) =>
        Effect.gen(function* () {
          const row = yield* Effect.sync(() =>
            db.query.apps.findFirst({ where: eq(apps.id, appId) }).sync(),
          );
          if (!row) {
            return yield* Effect.fail(new AppNotFoundError({ appId }));
          }

          // Stop any running containers tied to this app (regardless of activeDeploymentId).
          const containerIds = db
            .select({ id: deployments.containerId })
            .from(deployments)
            .where(eq(deployments.appId, appId))
            .all()
            .map((r) => r.id)
            .filter((id): id is string => Boolean(id));
          for (const cid of containerIds) {
            yield* docker.stopContainer(cid).pipe(Effect.catch(() => Effect.void));
            yield* docker.removeContainer(cid).pipe(Effect.catch(() => Effect.void));
          }
          yield* caddy
            .removeRoute(row.hostname.replace(/:.*$/, ""))
            .pipe(Effect.catch(() => Effect.void));

          yield* Effect.sync(() => {
            db.transaction((tx) => {
              const depIds = tx
                .select({ id: deployments.id })
                .from(deployments)
                .where(eq(deployments.appId, appId))
                .all()
                .map((r) => r.id);

              for (const depId of depIds) {
                tx.delete(deploymentLogs).where(eq(deploymentLogs.deploymentId, depId)).run();
                tx.delete(deploymentEvents).where(eq(deploymentEvents.deploymentId, depId)).run();
                tx.delete(deploymentEnvSnapshots)
                  .where(eq(deploymentEnvSnapshots.deploymentId, depId))
                  .run();
                tx.delete(deploymentOptionSnapshots)
                  .where(eq(deploymentOptionSnapshots.deploymentId, depId))
                  .run();
              }
              tx.delete(deploymentCommands).where(eq(deploymentCommands.appId, appId)).run();
              // Clear FK from apps -> deployments before deleting deployments.
              tx.update(apps)
                .set({ activeDeploymentId: null, updatedAt: nowIso() })
                .where(eq(apps.id, appId))
                .run();
              tx.delete(deployments).where(eq(deployments.appId, appId)).run();
              tx.delete(appEnvVars).where(eq(appEnvVars.appId, appId)).run();
              tx.delete(appSettings).where(eq(appSettings.appId, appId)).run();
              tx.delete(apps).where(eq(apps.id, appId)).run();
            });
          });
        }),
      streamLogs: (deploymentId) =>
        Stream.unwrap(
          getDeployment(deploymentId).pipe(
            Effect.map(() => {
              const persisted = db.query.deploymentLogs
                .findMany({
                  where: eq(deploymentLogs.deploymentId, deploymentId),
                  orderBy: [asc(deploymentLogs.sequence)],
                })
                .sync()
                .map(mapLog);
              const live = Stream.fromPubSub(logPubSub).pipe(
                Stream.filter((event) => event.deploymentId === deploymentId),
                Stream.filter(
                  (event) =>
                    !persisted.some((persistedEvent) => persistedEvent.sequence === event.sequence),
                ),
              );
              return Stream.concat(Stream.fromIterable(persisted), live);
            }),
          ),
        ),
      appendLog,
      appendLogLine,
      updateStatus,
      claimNextCommand: (workerId) =>
        Effect.sync(() => {
          const deploymentConcurrency = readDeploymentConcurrency();
          return db.transaction((tx) => {
            const running = tx
              .select({ value: count() })
              .from(deploymentCommands)
              .where(eq(deploymentCommands.status, "running"))
              .get();
            if ((running?.value ?? 0) >= deploymentConcurrency) {
              return undefined;
            }

            const row = tx.query.deploymentCommands
              .findFirst({
                where: eq(deploymentCommands.status, "pending"),
                orderBy: [asc(deploymentCommands.createdAt)],
              })
              .sync();
            if (!row) {
              return undefined;
            }
            const timestamp = nowIso();
            tx.update(deploymentCommands)
              .set({
                status: "running",
                claimedBy: workerId,
                claimedAt: timestamp,
                updatedAt: timestamp,
              })
              .where(eq(deploymentCommands.id, row.id))
              .run();
            const claimed = tx.query.deploymentCommands
              .findFirst({ where: eq(deploymentCommands.id, row.id) })
              .sync();
            return claimed ? mapCommand(claimed) : undefined;
          });
        }),
      completeCommand: (commandId) =>
        Effect.sync(() => {
          db.update(deploymentCommands)
            .set({ status: "succeeded", updatedAt: nowIso() })
            .where(eq(deploymentCommands.id, commandId))
            .run();
        }),
      failCommand: ({ commandId }) =>
        Effect.sync(() => {
          db.update(deploymentCommands)
            .set({ status: "failed", updatedAt: nowIso() })
            .where(eq(deploymentCommands.id, commandId))
            .run();
        }),
    };
    return svc;
  }),
);
