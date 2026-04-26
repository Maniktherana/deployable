import { Effect, Layer } from "effect";

import { ApiConfig } from "./Config/ApiConfig.ts";
import { DatabaseService } from "./Db/Database.ts";
import { ApiHttpServerLive } from "./Http/ApiHttpServer.ts";
import { BuildServiceLive } from "./Services/BuildService.ts";
import { CaddyServiceLive } from "./Services/CaddyService.ts";
import { DeploymentServiceLive } from "./Services/DeploymentService.ts";
import { RedisService } from "./Services/RedisService.ts";
import { DockerServiceLive } from "./Services/DockerService.ts";
import { SourceServiceLive } from "./Services/SourceService.ts";
import { makeSettingsServiceLive } from "./Services/SettingsService.ts";
import { DeploymentWorkerPoolLive } from "./Workers/DeploymentWorkerPool.ts";
import { OutboxPublisherLive } from "./Workers/OutboxPublisher.ts";

export const RuntimeDependenciesLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ApiConfig;
    const InfrastructureLive = Layer.mergeAll(
      DatabaseService.layerFromPath(config.databasePath),
      RedisService.layerFromUrl(config.redisUrl),
    );

    return Layer.empty.pipe(
      Layer.provideMerge(BuildServiceLive),
      Layer.provideMerge(makeSettingsServiceLive(config.deploymentConcurrency)),
      Layer.provideMerge(DeploymentServiceLive),
      Layer.provideMerge(DockerServiceLive),
      Layer.provideMerge(CaddyServiceLive),
      Layer.provideMerge(SourceServiceLive),
      Layer.provideMerge(InfrastructureLive),
    );
  }),
);

export const ApplicationLive = Layer.mergeAll(
  ApiHttpServerLive,
  DeploymentWorkerPoolLive,
  OutboxPublisherLive,
).pipe(Layer.provide(RuntimeDependenciesLive));

export const runServer = Layer.launch(ApplicationLive) satisfies Effect.Effect<
  never,
  unknown,
  ApiConfig
>;
