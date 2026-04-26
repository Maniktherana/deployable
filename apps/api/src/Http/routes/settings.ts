import { Effect, Schema } from "effect";
import { cast } from "effect/Function";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { RedisService } from "../../Services/RedisService.ts";
import { SettingsService } from "../../Services/SettingsService.ts";

const SettingsPatch = Schema.Struct({
  deploymentConcurrency: Schema.optional(Schema.Number),
});

export const getSettingsRouteLayer = HttpRouter.add(
  "GET",
  "/api/settings",
  Effect.gen(function* () {
    const svc = yield* SettingsService;
    return HttpServerResponse.jsonUnsafe(yield* svc.getSettings);
  }),
);

export const patchSettingsRouteLayer = HttpRouter.add(
  "PATCH",
  "/api/settings",
  Effect.gen(function* () {
    const svc = yield* SettingsService;
    const redis = yield* RedisService;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const raw = cast<unknown, Record<string, unknown>>(yield* req.json);
    const body = Schema.decodeUnknownSync(SettingsPatch)(raw);
    const updated = yield* svc.patchSettings(body);

    yield* Effect.all(
      Array.from({ length: updated.deploymentConcurrency }, (_, i) =>
        redis.publishSchedulerWakeup(`settings-updated-${i}`),
      ),
      { concurrency: 4 },
    );

    return HttpServerResponse.jsonUnsafe(updated);
  }),
);
