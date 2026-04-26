import { Effect, Schema, Stream } from "effect";
import { cast } from "effect/Function";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  type CreateDeploymentInput,
  CreateDeploymentInput as CreateDeploymentInputSchema,
  DeploymentId as DeploymentIdSchema,
} from "../../Domain/deployment.ts";
import { jsonEvent } from "../../Domain/http.ts";
import { DeploymentService } from "../../Services/DeploymentService.ts";

const decodeDeploymentId = (raw: string) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(DeploymentIdSchema)(raw),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

export const listDeploymentsRouteLayer = HttpRouter.add(
  "GET",
  "/api/deployments",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const items = yield* svc.listDeployments;
    return HttpServerResponse.jsonUnsafe({ items });
  }),
);

export const getDeploymentRouteLayer = HttpRouter.add(
  "GET",
  "/api/deployments/:id",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const params = yield* HttpRouter.params;
    const deploymentId = yield* decodeDeploymentId(params["id"]!);
    const deployment = yield* svc.getDeployment(deploymentId);
    return HttpServerResponse.jsonUnsafe(deployment);
  }),
);

export const createDeploymentRouteLayer = HttpRouter.add(
  "POST",
  "/api/deployments",
  Effect.gen(function* () {
    const svc = yield* DeploymentService;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const raw = cast<unknown, Record<string, unknown>>(yield* req.json);
    const input: CreateDeploymentInput = Schema.decodeUnknownSync(CreateDeploymentInputSchema)(raw);
    const deployment = yield* svc.createDeployment(input);
    return HttpServerResponse.jsonUnsafe(deployment, { status: 201 });
  }),
);

export const streamDeploymentLogsRouteLayer = (() => {
  const encoder = new TextEncoder();
  return HttpRouter.add(
    "GET",
    "/api/deployments/:id/logs/stream",
    Effect.gen(function* () {
      const svc = yield* DeploymentService;
      const params = yield* HttpRouter.params;
      const deploymentId = yield* decodeDeploymentId(params["id"]!);

      const sseStream = svc
        .streamLogs(deploymentId)
        .pipe(Stream.map((event) => encoder.encode(jsonEvent(event, { id: event.sequence }))));

      return HttpServerResponse.stream(sseStream, {
        status: 200,
        contentType: "text/event-stream",
        headers: {
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }),
  );
})();
