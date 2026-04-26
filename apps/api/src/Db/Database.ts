import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Context, Effect, Layer } from "effect";

import * as schema from "./schema.ts";

export type DeployableDatabase = BunSQLiteDatabase<typeof schema>;

export interface DatabaseServiceShape {
  readonly sqlite: Database;
  readonly db: DeployableDatabase;
}

export class DatabaseService extends Context.Service<DatabaseService, DatabaseServiceShape>()(
  "@deployable/api/Db/DatabaseService",
) {
  static readonly layerFromPath = (databasePath: string) =>
    Layer.effect(
      DatabaseService,
      Effect.acquireRelease(
        Effect.sync(() => {
          mkdirSync(dirname(databasePath), { recursive: true });
          const sqlite = new Database(databasePath);
          sqlite.exec("PRAGMA journal_mode = WAL");
          sqlite.exec("PRAGMA foreign_keys = ON");
          sqlite.exec("PRAGMA busy_timeout = 5000");
          const db = drizzle(sqlite, { schema });
          migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
          return {
            sqlite,
            db,
          } satisfies DatabaseServiceShape;
        }),
        ({ sqlite }) => Effect.sync(() => sqlite.close()),
      ),
    );
}
