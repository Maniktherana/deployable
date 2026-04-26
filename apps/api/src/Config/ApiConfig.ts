import { Context, Effect, Layer } from "effect";

export interface ApiConfigShape {
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly databasePath: string;
  readonly redisUrl: string;
  readonly deploymentConcurrency: number;
  readonly deploymentWorkerSlots: number;
  readonly caddyAdminUrl: string;
}

export class ApiConfig extends Context.Service<ApiConfig, ApiConfigShape>()(
  "@deployable/api/Config/ApiConfig",
) {
  static readonly layerFromEnv = Layer.effect(
    ApiConfig,
    Effect.sync(() => {
      const port = Number.parseInt(process.env.PORT ?? "4000", 10);
      const deploymentConcurrency = Number.parseInt(process.env.DEPLOYMENT_CONCURRENCY ?? "2", 10);
      const deploymentWorkerSlots = Number.parseInt(
        process.env.DEPLOYMENT_WORKER_SLOTS ?? "16",
        10,
      );
      return {
        host: process.env.HOST ?? "0.0.0.0",
        port: Number.isFinite(port) ? port : 4000,
        publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:8080",
        databasePath: process.env.DATABASE_PATH ?? ".deployable/deployable.sqlite",
        redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
        deploymentConcurrency: Number.isFinite(deploymentConcurrency) ? deploymentConcurrency : 2,
        deploymentWorkerSlots: Number.isFinite(deploymentWorkerSlots) ? deploymentWorkerSlots : 16,
        caddyAdminUrl: process.env.CADDY_ADMIN_URL ?? "http://localhost:2019",
      } satisfies ApiConfigShape;
    }),
  );
}
