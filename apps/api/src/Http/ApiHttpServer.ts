import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { ApiConfig } from "../Config/ApiConfig.ts";
import {
  listAppsRouteLayer,
  getAppRouteLayer,
  updateAppRouteLayer,
  deleteAppRouteLayer,
  getAppBuildConfigRouteLayer,
  listAppDeploymentsRouteLayer,
  listAppEnvRouteLayer,
  redeployRouteLayer,
  restartAppRouteLayer,
  rollbackRouteLayer,
  setAppBuildConfigRouteLayer,
  setAppEnvRouteLayer,
  stopAppRouteLayer,
} from "./routes/apps.ts";
import { healthRouteLayer, apiHealthRouteLayer } from "./routes/health.ts";
import {
  listDeploymentsRouteLayer,
  getDeploymentRouteLayer,
  createDeploymentRouteLayer,
  streamDeploymentLogsRouteLayer,
} from "./routes/deployments.ts";
import { getSettingsRouteLayer, patchSettingsRouteLayer } from "./routes/settings.ts";
import {
  gitPreflightRouteLayer,
  railpackPreflightRouteLayer,
  uploadArchiveRouteLayer,
} from "./routes/source.ts";

export const makeRoutesLayer = Layer.mergeAll(
  healthRouteLayer,
  apiHealthRouteLayer,
  listAppsRouteLayer,
  getAppRouteLayer,
  updateAppRouteLayer,
  deleteAppRouteLayer,
  stopAppRouteLayer,
  listAppDeploymentsRouteLayer,
  listAppEnvRouteLayer,
  setAppEnvRouteLayer,
  getAppBuildConfigRouteLayer,
  setAppBuildConfigRouteLayer,
  rollbackRouteLayer,
  restartAppRouteLayer,
  redeployRouteLayer,
  listDeploymentsRouteLayer,
  getDeploymentRouteLayer,
  createDeploymentRouteLayer,
  streamDeploymentLogsRouteLayer,
  getSettingsRouteLayer,
  patchSettingsRouteLayer,
  gitPreflightRouteLayer,
  railpackPreflightRouteLayer,
  uploadArchiveRouteLayer,
).pipe(Layer.provide(HttpRouter.cors()));

export const ApiHttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ApiConfig;

    return HttpRouter.serve(makeRoutesLayer).pipe(
      HttpServer.withLogAddress,
      Layer.provideMerge(BunHttpServer.layer({ port: config.port, hostname: config.host })),
    );
  }),
);
