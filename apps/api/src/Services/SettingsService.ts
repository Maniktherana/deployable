import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { DatabaseService } from "../Db/Database.ts";
import { settings } from "../Db/schema.ts";

const DEPLOYMENT_CONCURRENCY_KEY = "deployment.concurrency";

export interface AppSettings {
  readonly deploymentConcurrency: number;
}

export interface SettingsServiceShape {
  readonly getSettings: Effect.Effect<AppSettings>;
  readonly patchSettings: (input: {
    readonly deploymentConcurrency?: number;
  }) => Effect.Effect<AppSettings, SettingsValidationError>;
  readonly getDeploymentConcurrency: Effect.Effect<number>;
}

export class SettingsValidationError extends Error {
  override readonly name = "SettingsValidationError";
}

export class SettingsService extends Context.Service<SettingsService, SettingsServiceShape>()(
  "@deployable/api/Services/SettingsService",
) {}

export const makeSettingsServiceLive = (defaultDeploymentConcurrency: number) =>
  Layer.effect(
    SettingsService,
    Effect.gen(function* () {
      const { db } = yield* DatabaseService;

      const defaultConcurrency = normalizeConcurrency(defaultDeploymentConcurrency);

      const readDeploymentConcurrency = () => {
        const row = db.query.settings
          .findFirst({ where: eq(settings.key, DEPLOYMENT_CONCURRENCY_KEY) })
          .sync();
        if (!row) {
          return undefined;
        }
        const parsed = JSON.parse(row.valueJson) as unknown;
        return typeof parsed === "number" ? normalizeConcurrency(parsed) : undefined;
      };

      const writeDeploymentConcurrency = (value: number) => {
        const timestamp = new Date().toISOString();
        const existing = db.query.settings
          .findFirst({ where: eq(settings.key, DEPLOYMENT_CONCURRENCY_KEY) })
          .sync();
        if (existing) {
          db.update(settings)
            .set({ valueJson: JSON.stringify(value), updatedAt: timestamp })
            .where(eq(settings.key, DEPLOYMENT_CONCURRENCY_KEY))
            .run();
          return;
        }
        db.insert(settings)
          .values({
            key: DEPLOYMENT_CONCURRENCY_KEY,
            valueJson: JSON.stringify(value),
            updatedAt: timestamp,
          })
          .run();
      };

      if (readDeploymentConcurrency() === undefined) {
        writeDeploymentConcurrency(defaultConcurrency);
      }

      const getDeploymentConcurrency = Effect.sync(
        () => readDeploymentConcurrency() ?? defaultConcurrency,
      );

      const getSettings = getDeploymentConcurrency.pipe(
        Effect.map((deploymentConcurrency) => ({ deploymentConcurrency })),
      );

      return {
        getSettings,
        getDeploymentConcurrency,
        patchSettings: (input) =>
          Effect.gen(function* () {
            if (input.deploymentConcurrency !== undefined) {
              if (!Number.isInteger(input.deploymentConcurrency)) {
                return yield* Effect.fail(
                  new SettingsValidationError("deploymentConcurrency must be an integer"),
                );
              }
              writeDeploymentConcurrency(normalizeConcurrency(input.deploymentConcurrency));
            }
            return yield* getSettings;
          }),
      } satisfies SettingsServiceShape;
    }),
  );

function normalizeConcurrency(value: number): number {
  return Math.min(16, Math.max(1, value));
}
