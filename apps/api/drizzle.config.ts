import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/Db/schema.ts",
  out: "./drizzle",
});
