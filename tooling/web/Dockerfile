FROM oven/bun:1.3.11 AS deps

WORKDIR /workspace

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY tooling/package.json ./tooling/
COPY packages/typescript-config/package.json ./packages/typescript-config/

RUN bun install --frozen-lockfile

FROM deps AS build

COPY . .
RUN bun run --filter @deployable/web build

FROM oven/bun:1.3.11 AS final

WORKDIR /workspace

COPY --from=build /workspace/apps/web/dist ./apps/web/dist
COPY --from=build /workspace/apps/web/server ./apps/web/server

CMD ["bun", "apps/web/server/serve.ts"]
