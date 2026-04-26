import { Effect, Schema } from "effect";
import { cast } from "effect/Function";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  AppId as AppIdSchema,
  DeploymentId as DeploymentIdSchema,
} from "../../Domain/deployment.ts";
import { DeploymentService } from "../../Services/DeploymentService.ts";

const decodeAppId = (raw: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(AppIdSchema)(raw),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const decodeDeploymentId = (raw: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(DeploymentIdSchema)(raw),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

export const listAppsRouteLayer = HttpRouter.add(
  "GET",
  "/api/apps",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const items = yield* svc.listApps;
    return HttpServerResponse.jsonUnsafe({ items });
  }),
);

export const getAppRouteLayer = HttpRouter.add(
  "GET",
  "/api/apps/:id",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    const app = yield* svc.getApp(appId);
    return HttpServerResponse.jsonUnsafe(app);
  }),
);

export const updateAppRouteLayer = HttpRouter.add(
  "PATCH",
  "/api/apps/:id",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    const req = yield* HttpServerRequest.HttpServerRequest;
    const body = cast<unknown, Record<string, unknown>>(yield* req.json);
    const app = yield* svc.updateApp({
      appId,
      name: typeof body.name === "string" ? body.name : undefined,
      hostname: typeof body.hostname === "string" ? body.hostname : undefined,
    });
    return HttpServerResponse.jsonUnsafe(app);
  }),
);

export const deleteAppRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/apps/:id",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    yield* svc.deleteApp(appId);
    return HttpServerResponse.jsonUnsafe({ ok: true });
  }),
);

export const stopAppRouteLayer = HttpRouter.add(
  "POST",
  "/api/apps/:id/stop",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    const app = yield* svc.stopApp(appId);
    return HttpServerResponse.jsonUnsafe(app);
  }),
);

export const listAppDeploymentsRouteLayer = HttpRouter.add(
  "GET",
  "/api/apps/:id/deployments",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    const items = yield* svc.listDeploymentsByApp(appId);
    return HttpServerResponse.jsonUnsafe({ items });
  }),
);

export const rollbackRouteLayer = HttpRouter.add(
  "POST",
  "/api/apps/:id/rollback",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    const req = yield* HttpServerRequest.HttpServerRequest;
    const body = cast<unknown, Record<string, unknown>>(yield* req.json);
    const targetDeploymentId = yield* decodeDeploymentId(body.deploymentId as string);
    const deployment = yield* svc.rollbackDeployment({ appId, targetDeploymentId });
    return HttpServerResponse.jsonUnsafe(deployment, { status: 201 });
  }),
);

export const restartAppRouteLayer = HttpRouter.add(
  "POST",
  "/api/apps/:id/restart",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    const req = yield* HttpServerRequest.HttpServerRequest;
    const body = cast<unknown, Record<string, unknown>>(yield* req.json);
    const deploymentId = yield* decodeDeploymentId(body.deploymentId as string);
    const app = yield* svc.restartApp({ appId, deploymentId });
    return HttpServerResponse.jsonUnsafe(app);
  }),
);

export const redeployRouteLayer = HttpRouter.add(
  "POST",
  "/api/apps/:id/redeploy",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    const req = yield* HttpServerRequest.HttpServerRequest;
    const body = cast<unknown, Record<string, unknown>>(yield* req.json);
    const sourceDeploymentId = yield* decodeDeploymentId(body.deploymentId as string);
    const deployment = yield* svc.redeployDeployment({ appId, sourceDeploymentId });
    return HttpServerResponse.jsonUnsafe(deployment, { status: 201 });
  }),
);

export const listAppEnvRouteLayer = HttpRouter.add(
  "GET",
  "/api/apps/:id/env",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    const envVars = yield* svc
      .listAppEnv(appId)
      .pipe(
        Effect.catchTag("AppNotFoundError", () => Effect.succeed({} as Record<string, string>)),
      );
    return HttpServerResponse.jsonUnsafe({ envVars });
  }),
);

export const setAppEnvRouteLayer = HttpRouter.add(
  "PUT",
  "/api/apps/:id/env",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    const req = yield* HttpServerRequest.HttpServerRequest;
    const body = cast<unknown, Record<string, unknown>>(yield* req.json);
    const raw = body.envVars;
    const envVars: Record<string, string> = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "string") envVars[k] = v;
      }
    }
    const updated = yield* svc.setAppEnv({ appId, envVars });
    return HttpServerResponse.jsonUnsafe({ envVars: updated });
  }),
);

export const getAppBuildConfigRouteLayer = HttpRouter.add(
  "GET",
  "/api/apps/:id/build-config",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    // Mirror the env endpoint behaviour: a missing app simply means "no
    // overrides yet". Surfacing 404 to the client just makes the settings
    // dialog spam toasts on a brand-new project.
    const cfg = yield* svc
      .getAppBuildConfig(appId)
      .pipe(Effect.catchTag("AppNotFoundError", () => Effect.succeed({})));
    return HttpServerResponse.jsonUnsafe(cfg);
  }),
);

export const setAppBuildConfigRouteLayer = HttpRouter.add(
  "PUT",
  "/api/apps/:id/build-config",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const appId = yield* decodeAppId(params["id"]!);
    const req = yield* HttpServerRequest.HttpServerRequest;
    const body = cast<unknown, Record<string, unknown>>(yield* req.json);
    const buildCommand = typeof body.buildCommand === "string" ? body.buildCommand : undefined;
    const startCommand = typeof body.startCommand === "string" ? body.startCommand : undefined;
    const updated = yield* svc.setAppBuildConfig({ appId, buildCommand, startCommand });
    return HttpServerResponse.jsonUnsafe(updated);
  }),
);
