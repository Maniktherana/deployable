import { Effect, Layer, Queue, Stream } from "effect";
import { eq, isNotNull } from "drizzle-orm";

import { ApiConfig } from "../Config/ApiConfig.ts";
import { DatabaseService } from "../Db/Database.ts";
import {
  appEnvVars,
  appSettings,
  apps,
  deploymentEnvSnapshots,
  deployments as deploymentsTable,
} from "../Db/schema.ts";
import { type DeploymentSource } from "../Domain/deployment.ts";
import { BuildService } from "../Services/BuildService.ts";
import { CaddyService, type CaddyRoute } from "../Services/CaddyService.ts";
import { DeploymentService, type DeploymentCommand } from "../Services/DeploymentService.ts";
import { DockerService } from "../Services/DockerService.ts";
import { RedisService } from "../Services/RedisService.ts";
import { SourceService } from "../Services/SourceService.ts";

const NETWORK = "deployable";
const DEFAULT_PORT = 3000;
const HEALTH_TIMEOUT_MS = 60_000;
const nowIso = () => new Date().toISOString();

export const DeploymentWorkerPoolLive = Layer.effectDiscard(
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ApiConfig;
      const { db } = yield* DatabaseService;
      const svc = yield* DeploymentService;
      const redis = yield* RedisService;
      const source = yield* SourceService;
      const buildSvc = yield* BuildService;
      const docker = yield* DockerService;
      const caddy = yield* CaddyService;
      const workerSlots = Math.max(1, config.deploymentWorkerSlots);
      const wakeups = yield* Queue.sliding<void>(workerSlots);

      const log = (
        deploymentId: string,
        phase: "prepare" | "build" | "deploy" | "runtime",
        level: "info" | "warn" | "error",
        message: string,
      ) => svc.appendLogLine({ deploymentId: deploymentId as any, phase, level, message });

      const stopPreviousDeployment = (appId: string, currentDeploymentId: string) =>
        Effect.gen(function* () {
          const appRow = db.select().from(apps).where(eq(apps.id, appId)).get();
          const prevId = appRow?.activeDeploymentId;
          if (!prevId || prevId === currentDeploymentId) return;

          const prev = db
            .select()
            .from(deploymentsTable)
            .where(eq(deploymentsTable.id, prevId))
            .get();
          if (!prev || prev.status !== "running" || !prev.containerId) return;

          yield* log(
            currentDeploymentId as any,
            "deploy",
            "info",
            `Stopping previous deployment ${prevId}...`,
          );
          yield* docker.stopContainer(prev.containerId).pipe(Effect.catch(() => Effect.void));
          yield* docker.removeContainer(prev.containerId).pipe(Effect.catch(() => Effect.void));
          yield* Effect.sync(() => {
            db.update(deploymentsTable)
              .set({ status: "stopped", updatedAt: nowIso() })
              .where(eq(deploymentsTable.id, prevId))
              .run();
          });
          yield* log(
            currentDeploymentId as any,
            "deploy",
            "info",
            `Previous deployment ${prevId} stopped.`,
          );
        });

      const deployContainer = (command: DeploymentCommand, imageTag: string) =>
        Effect.gen(function* () {
          yield* svc.updateStatus({
            deploymentId: command.deploymentId,
            status: "deploying",
            imageTag,
          });
          yield* log(command.deploymentId, "deploy", "info", "Starting container...");

          const envRows = db
            .select()
            .from(appEnvVars)
            .where(eq(appEnvVars.appId, command.appId))
            .all();
          const envVars: Record<string, string> = {};
          for (const row of envRows) envVars[row.key] = row.value;

          yield* Effect.sync(() => {
            for (const row of envRows) {
              db.insert(deploymentEnvSnapshots)
                .values({ deploymentId: command.deploymentId, key: row.key, value: row.value })
                .onConflictDoUpdate({
                  target: [deploymentEnvSnapshots.deploymentId, deploymentEnvSnapshots.key],
                  set: { value: row.value },
                })
                .run();
            }
          });

          const settingsRow = db
            .select()
            .from(appSettings)
            .where(eq(appSettings.appId, command.appId))
            .get();
          const appPort = settingsRow?.port ?? DEFAULT_PORT;
          const healthPath = settingsRow?.healthPath ?? "/";
          envVars.PORT = String(appPort);

          const appRow = db.select().from(apps).where(eq(apps.id, command.appId)).get();
          const slug = appRow?.slug ?? command.appId;
          const containerName = `deployable-${slug}-${command.deploymentId.slice(0, 12)}`;

          yield* docker.ensureNetwork(NETWORK);

          const container = yield* docker.runContainer({
            imageTag,
            name: containerName,
            envVars,
            labels: {
              "deployable.app": command.appId,
              "deployable.deployment": command.deploymentId,
              "deployable.slug": slug,
            },
            network: NETWORK,
          });
          yield* log(
            command.deploymentId,
            "deploy",
            "info",
            `Container started: ${container.containerId.slice(0, 12)}`,
          );

          yield* log(
            command.deploymentId,
            "deploy",
            "info",
            `Health check: ${healthPath} on port ${appPort}...`,
          );
          const healthy = yield* docker.waitForHealthy({
            containerId: container.containerId,
            healthPath,
            port: appPort,
            timeoutMs: HEALTH_TIMEOUT_MS,
          });
          if (!healthy) {
            yield* log(
              command.deploymentId,
              "deploy",
              "warn",
              "Health check timed out — container may still be starting.",
            );
          } else {
            yield* log(command.deploymentId, "deploy", "info", "Health check passed.");
          }

          const hostname = (appRow?.hostname ?? `${slug}.localhost`).replace(/:.*$/, "");
          const upstream = `${containerName}:${appPort}`;
          yield* log(command.deploymentId, "deploy", "info", `Route: ${hostname} → ${upstream}`);
          yield* caddy
            .addRoute({ hostname, upstream })
            .pipe(
              Effect.catch((e) =>
                log(
                  command.deploymentId,
                  "deploy",
                  "warn",
                  `Caddy route failed: ${e}. Container is running.`,
                ),
              ),
            );

          // Blue/green: stop previous deployment before switching active
          yield* stopPreviousDeployment(command.appId, command.deploymentId);

          const liveUrl = `http://${appRow?.hostname ?? `${slug}.localhost:8080`}`;
          yield* svc.updateStatus({
            deploymentId: command.deploymentId,
            status: "running",
            imageTag,
            liveUrl,
            containerId: container.containerId,
          });
          yield* log(command.deploymentId, "deploy", "info", `Live at ${liveUrl}`);
          yield* svc.completeCommand(command.id);

          yield* Effect.sync(() => {
            db.update(apps)
              .set({ activeDeploymentId: command.deploymentId, updatedAt: nowIso() })
              .where(eq(apps.id, command.appId))
              .run();
          });
        });

      const handleCommand = (command: DeploymentCommand, workerId: string) =>
        Effect.gen(function* () {
          yield* log(
            command.deploymentId,
            "prepare",
            "info",
            `Worker ${workerId} claimed ${command.type} command ${command.id}.`,
          );
          const deployment = yield* svc.getDeployment(command.deploymentId);

          if (command.type === "rollback") {
            // Rollback: skip source+build, reuse existing image
            const imageTag = deployment.imageTag;
            if (!imageTag) {
              return yield* Effect.fail(new Error("Rollback deployment has no imageTag"));
            }
            yield* log(command.deploymentId, "deploy", "info", `Rollback using image ${imageTag}`);
            yield* deployContainer(command, imageTag);
            return;
          }

          // Normal build deployment
          const deploymentSource = deployment.source as DeploymentSource;
          yield* svc.updateStatus({ deploymentId: command.deploymentId, status: "building" });

          const sourceDir = yield* source.prepareSourceDir(command.deploymentId);
          yield* log(command.deploymentId, "prepare", "info", `Source directory: ${sourceDir}`);

          if (deploymentSource.type === "git") {
            const ref = deploymentSource.ref ?? "HEAD";
            yield* log(
              command.deploymentId,
              "prepare",
              "info",
              `Cloning ${deploymentSource.url} (ref: ${ref})...`,
            );
            yield* source.gitShallowClone({ url: deploymentSource.url, ref, targetDir: sourceDir });
            yield* log(command.deploymentId, "prepare", "info", "Clone complete.");
          } else if (deploymentSource.type === "upload") {
            yield* log(
              command.deploymentId,
              "prepare",
              "info",
              `Extracting upload: ${deploymentSource.filename}`,
            );
            yield* source.extractArchive({
              archivePath: deploymentSource.filename,
              targetDir: sourceDir,
            });
            yield* log(command.deploymentId, "prepare", "info", "Extraction complete.");
          } else {
            return yield* Effect.fail(new Error("Unsupported source type for build"));
          }

          const imageTag = `deployable/${deployment.appId}:${command.deploymentId}`;
          yield* log(
            command.deploymentId,
            "build",
            "info",
            `Building image ${imageTag} with railpack...`,
          );

          // Pull build/start command overrides from app_settings so the user's
          // configured railpack flags are honoured for every deployment.
          const buildCfgRow = db
            .select({
              buildCommand: appSettings.buildCommand,
              startCommand: appSettings.startCommand,
            })
            .from(appSettings)
            .where(eq(appSettings.appId, command.appId))
            .get();
          if (buildCfgRow?.buildCommand) {
            yield* log(
              command.deploymentId,
              "build",
              "info",
              `Using custom build command: ${buildCfgRow.buildCommand}`,
            );
          }
          if (buildCfgRow?.startCommand) {
            yield* log(
              command.deploymentId,
              "build",
              "info",
              `Using custom start command: ${buildCfgRow.startCommand}`,
            );
          }

          const logStream = yield* buildSvc.build({
            sourceDir,
            imageTag,
            buildCommand: buildCfgRow?.buildCommand ?? undefined,
            startCommand: buildCfgRow?.startCommand ?? undefined,
          });
          yield* logStream.pipe(
            Stream.runForEach((line) => log(command.deploymentId, "build", "info", line)),
          );
          yield* log(command.deploymentId, "build", "info", `Image built: ${imageTag}`);
          yield* source
            .cleanupSourceDir(command.deploymentId)
            .pipe(Effect.catch(() => Effect.void));

          yield* deployContainer(command, imageTag);
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* log(
                command.deploymentId,
                "deploy",
                "error",
                `Worker ${workerId} failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              yield* svc.updateStatus({ deploymentId: command.deploymentId, status: "failed" });
              yield* svc.failCommand({ commandId: command.id, reason: String(error) });
              yield* source
                .cleanupSourceDir(command.deploymentId)
                .pipe(Effect.catch(() => Effect.void));
              // Remove any Caddy route that may have been added before the failure.
              const appRow = db.select().from(apps).where(eq(apps.id, command.appId)).get();
              if (appRow) {
                const hostname = appRow.hostname.replace(/:.*$/, "");
                yield* caddy.removeRoute(hostname).pipe(Effect.catch(() => Effect.void));
              }
            }),
          ),
        );

      const drain = (workerId: string): Effect.Effect<void> =>
        svc.claimNextCommand(workerId).pipe(
          Effect.flatMap((command) => {
            if (!command) return Effect.void;
            return Effect.logInfo(`${workerId} claimed command ${command.id}`).pipe(
              Effect.andThen(handleCommand(command, workerId)),
              Effect.andThen(drain(workerId)),
            );
          }),
          Effect.catch((err) => Effect.logWarning(`${workerId} drain error: ${err}`)),
        );

      const worker = (index: number) => {
        const workerId = `worker-${index}-${crypto.randomUUID().slice(0, 8)}`;
        return Queue.take(wakeups).pipe(Effect.andThen(drain(workerId)), Effect.forever);
      };

      const schedulerLoop: Effect.Effect<void> = redis.waitForCommandWakeup().pipe(
        Effect.andThen(Queue.offer(wakeups, undefined)),
        Effect.catch((error) =>
          Effect.logError(`Redis command wakeup failed: ${error.message}`).pipe(
            Effect.andThen(Effect.sleep("1 second")),
          ),
        ),
        Effect.andThen(Effect.suspend(() => schedulerLoop)),
      );

      // Startup reconciliation: verify containers are actually running, fix DB
      // state for any that died while the API was down, then rebuild Caddy routes.
      yield* Effect.gen(function* () {
        const runningDeps = db
          .select()
          .from(deploymentsTable)
          .where(eq(deploymentsTable.status, "running"))
          .all();

        const routes: CaddyRoute[] = [];
        const ts = nowIso();

        for (const dep of runningDeps) {
          const app = db.select().from(apps).where(eq(apps.id, dep.appId)).get();
          if (!app || !dep.containerId) {
            // No container — mark stopped and clear activeDeploymentId
            db.update(deploymentsTable)
              .set({ status: "stopped", liveUrl: null, updatedAt: ts })
              .where(eq(deploymentsTable.id, dep.id))
              .run();
            db.update(apps)
              .set({ activeDeploymentId: null, updatedAt: ts })
              .where(eq(apps.id, dep.appId))
              .run();
            yield* Effect.logWarning(`Deployment ${dep.id}: no container — marked stopped`);
            continue;
          }

          const info = yield* docker
            .inspectContainer(dep.containerId)
            .pipe(Effect.catch(() => Effect.succeed(null)));

          if (!info || info.state !== "running") {
            // Container is gone or dead — mark stopped in DB
            db.update(deploymentsTable)
              .set({ status: "stopped", liveUrl: null, updatedAt: ts })
              .where(eq(deploymentsTable.id, dep.id))
              .run();
            db.update(apps)
              .set({ activeDeploymentId: null, updatedAt: ts })
              .where(eq(apps.id, dep.appId))
              .run();
            yield* Effect.logWarning(
              `Deployment ${dep.id}: container ${dep.containerId.slice(0, 12)} is ${info?.state ?? "missing"} — marked stopped`,
            );
            continue;
          }

          const settings = db
            .select()
            .from(appSettings)
            .where(eq(appSettings.appId, dep.appId))
            .get();
          const port = settings?.port ?? DEFAULT_PORT;
          const containerName = `deployable-${app.slug}-${dep.id.slice(0, 12)}`;
          routes.push({
            hostname: app.hostname.replace(/:.*$/, ""),
            upstream: `${containerName}:${port}`,
          });
        }

        if (routes.length > 0) {
          yield* caddy.reconcileRoutes(routes).pipe(
            Effect.andThen(Effect.logInfo(`Reconciled ${routes.length} Caddy route(s)`)),
            Effect.catch((e) => Effect.logWarning(`Route reconciliation failed: ${e}`)),
          );
        } else {
          yield* Effect.logInfo("No running deployments to reconcile");
        }

        // Auto-restart pass: any app whose activeDeploymentId points at a
        // stopped deployment with a built image is brought back online. This
        // covers the `docker compose down` → `docker compose up` flow where
        // we want apps to come back automatically.
        const appsToRestore = db
          .select()
          .from(apps)
          .where(isNotNull(apps.activeDeploymentId))
          .all();

        let restarted = 0;
        for (const app of appsToRestore) {
          if (!app.activeDeploymentId) continue;
          const dep = db
            .select()
            .from(deploymentsTable)
            .where(eq(deploymentsTable.id, app.activeDeploymentId))
            .get();
          if (!dep || dep.status !== "stopped" || !dep.imageTag) continue;

          yield* Effect.logInfo(`Auto-restarting ${app.slug} (${dep.id.slice(0, 12)})...`);
          const result = yield* svc
            .restartApp({ appId: app.id as any, deploymentId: dep.id as any })
            .pipe(
              Effect.catch((e) =>
                Effect.logWarning(`Auto-restart failed for ${app.slug}: ${e}`).pipe(
                  Effect.as(null),
                ),
              ),
            );
          if (result) restarted += 1;
        }
        if (restarted > 0) {
          yield* Effect.logInfo(`Auto-restarted ${restarted} deployment(s) on startup.`);
        }
      }).pipe(Effect.catch((e) => Effect.logWarning(`Startup reconciliation error: ${e}`)));

      for (let index = 0; index < workerSlots; index += 1) {
        yield* worker(index + 1).pipe(Effect.forkScoped);
        yield* Queue.offer(wakeups, undefined);
      }

      yield* schedulerLoop.pipe(Effect.forkScoped);
      yield* Effect.logInfo(`Deployment worker pool started with ${workerSlots} slots`);

      // Kick off railpack/mise cache warmup in the background so the very
      // first /api/source/preflight from the deploy form doesn't pay the
      // ~15s mise cold start. No-op once warm.
      yield* source.prewarmRailpack();

      // On shutdown: stop all running containers but keep activeDeploymentId
      // pointed at the deployment so the next startup can auto-restart it.
      // Wrapped in Effect.uninterruptible so the docker calls can't be cancelled
      // mid-flight when the parent fiber is interrupted.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Shutting down: stopping all running deployments...");
          const runningDeps = db
            .select()
            .from(deploymentsTable)
            .where(eq(deploymentsTable.status, "running"))
            .all();
          yield* Effect.logInfo(`Found ${runningDeps.length} running deployment(s) to stop.`);

          for (const dep of runningDeps) {
            const containerId = dep.containerId;
            if (containerId) {
              const short = containerId.slice(0, 12);
              yield* Effect.logInfo(`Stopping container ${short}...`);
              yield* docker
                .stopContainer(containerId)
                .pipe(Effect.catch((e) => Effect.logWarning(`Stop failed for ${short}: ${e}`)));
              yield* docker
                .removeContainer(containerId)
                .pipe(Effect.catch((e) => Effect.logWarning(`Remove failed for ${short}: ${e}`)));
            }
            // Mark deployment stopped but DON'T clear activeDeploymentId — we
            // want the next startup's reconciliation to know which deployment
            // to bring back online.
            db.update(deploymentsTable)
              .set({ status: "stopped", liveUrl: null, updatedAt: nowIso() })
              .where(eq(deploymentsTable.id, dep.id))
              .run();
          }

          yield* Effect.logInfo(`Shutdown cleanup complete (${runningDeps.length} deployment(s)).`);
        }).pipe(
          Effect.catch((e) => Effect.logWarning(`Shutdown cleanup error: ${e}`)),
          Effect.uninterruptible,
        ),
      );

      yield* Effect.never;
    }),
  ),
);
