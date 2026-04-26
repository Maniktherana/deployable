import { Effect, Fiber } from "effect";

import { ApiConfig } from "./Config/ApiConfig.ts";
import { runServer } from "./server.ts";

const fiber = Effect.runFork(runServer.pipe(Effect.provide(ApiConfig.layerFromEnv)));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // Fiber.interrupt sends interrupt and awaits full teardown including finalizers
    Fiber.interrupt(fiber)
      .pipe(Effect.runPromise)
      .then(
        () => process.exit(0),
        () => process.exit(0),
      );
  });
}
