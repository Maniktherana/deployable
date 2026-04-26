import { Redis } from "ioredis";
import { Context, Effect, Layer } from "effect";

export interface RedisServiceShape {
  readonly publishCommandWakeup: (commandId: string) => Effect.Effect<void, Error>;
  readonly publishSchedulerWakeup: (reason: string) => Effect.Effect<void, Error>;
  readonly waitForCommandWakeup: () => Effect.Effect<void, Error>;
  readonly publishLogWakeup: (deploymentId: string) => Effect.Effect<void, Error>;
  readonly publishEventWakeup: (deploymentId: string) => Effect.Effect<void, Error>;
}

export class RedisService extends Context.Service<RedisService, RedisServiceShape>()(
  "@deployable/api/Services/RedisService",
) {
  static readonly layerFromUrl = (redisUrl: string) =>
    Layer.effect(
      RedisService,
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const publisher = new Redis(redisUrl, {
              lazyConnect: true,
              maxRetriesPerRequest: null,
            });
            const subscriber = new Redis(redisUrl, {
              lazyConnect: true,
              maxRetriesPerRequest: null,
            });
            await Promise.all([publisher.connect(), subscriber.connect()]);

            const xadd = (stream: string, fields: Record<string, string>) =>
              Effect.tryPromise({
                try: async () => {
                  const args: Array<string> = [];
                  for (const [k, v] of Object.entries(fields)) {
                    args.push(k, v);
                  }
                  await publisher.xadd(stream, "*", ...args);
                },
                catch: toError,
              });

            return {
              publishCommandWakeup: (commandId: string) =>
                xadd("deployable:commands", { commandId }),
              publishSchedulerWakeup: (reason: string) => xadd("deployable:commands", { reason }),
              waitForCommandWakeup: () =>
                Effect.tryPromise({
                  try: async () => {
                    await subscriber.xread("BLOCK", 0, "STREAMS", "deployable:commands", "$");
                  },
                  catch: toError,
                }),
              publishLogWakeup: (deploymentId: string) => xadd("deployable:logs", { deploymentId }),
              publishEventWakeup: (deploymentId: string) =>
                xadd("deployable:events", { deploymentId }),
              close: async () => {
                await Promise.all([publisher.quit(), subscriber.quit()]);
              },
            };
          },
          catch: toError,
        }),
        (service) => Effect.promise(() => service.close()),
      ).pipe(
        Effect.map(
          ({
            publishCommandWakeup,
            publishSchedulerWakeup,
            waitForCommandWakeup,
            publishLogWakeup,
            publishEventWakeup,
          }) => ({
            publishCommandWakeup,
            publishSchedulerWakeup,
            waitForCommandWakeup,
            publishLogWakeup,
            publishEventWakeup,
          }),
        ),
      ),
    );
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
