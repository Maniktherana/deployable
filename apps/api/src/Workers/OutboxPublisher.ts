import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DatabaseService } from "../Db/Database.ts";
import { outboxEvents } from "../Db/schema.ts";
import { RedisService } from "../Services/RedisService.ts";

const BATCH_SIZE = 50;

const drainBatch = Effect.gen(function* () {
  const { db } = yield* DatabaseService;
  const redis = yield* RedisService;

  const pending = db.query.outboxEvents
    .findMany({
      where: eq(outboxEvents.status, "pending"),
      orderBy: [asc(outboxEvents.createdAt)],
      limit: BATCH_SIZE,
    })
    .sync();

  if (pending.length === 0) return 0;

  for (const row of pending) {
    const payload = JSON.parse(row.payloadJson) as Record<string, string>;
    const deploymentId = payload.deploymentId ?? "unknown";

    const publish =
      row.topic === "deployment.logs.appended"
        ? redis.publishLogWakeup(deploymentId)
        : redis.publishEventWakeup(deploymentId);

    yield* publish.pipe(
      Effect.andThen(
        Effect.sync(() => {
          db.update(outboxEvents)
            .set({ status: "published", publishedAt: new Date().toISOString() })
            .where(eq(outboxEvents.id, row.id))
            .run();
        }),
      ),
      Effect.catch((error: unknown) =>
        Effect.sync(() => {
          db.update(outboxEvents)
            .set({ status: "failed" })
            .where(eq(outboxEvents.id, row.id))
            .run();
        }).pipe(Effect.andThen(Effect.logWarning(`Outbox publish failed for ${row.id}: ${error}`))),
      ),
    );
  }

  return pending.length;
});

const pollLoop = drainBatch.pipe(
  Effect.flatMap((published) =>
    published >= BATCH_SIZE ? Effect.void : Effect.sleep("500 millis"),
  ),
  Effect.catch((error: unknown) =>
    Effect.logError(`Outbox publisher error: ${error}`).pipe(
      Effect.andThen(Effect.sleep("2 seconds")),
    ),
  ),
  Effect.forever,
);

export const OutboxPublisherLive = Layer.effectDiscard(
  Effect.scoped(
    Effect.gen(function* () {
      yield* pollLoop.pipe(Effect.forkScoped);
      yield* Effect.logInfo("Outbox publisher started");
      yield* Effect.never;
    }),
  ),
);
