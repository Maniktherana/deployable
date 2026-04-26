# Deployable

A small, single-node mini-PaaS. Submit a Git URL or upload a project; Deployable runs it through [Railpack](https://railpack.com) → Docker → [Caddy](https://caddyserver.com) and gives you a live URL with build/deploy logs streamed to the browser as they happen.

The whole thing comes up with `docker compose up`.

---

## Getting started

```bash
docker network create deployable
docker compose up --build
open http://localhost:8080
```

Then create a project from a public Git URL (e.g. `https://github.com/railwayapp-templates/express-starter`) or drop a `.zip` / `.tar.gz` of any [Railpack-supported](https://railpack.com/docs/languages) source. When the deploy goes green you'll get a live URL like `http://express-starter.localhost:8080`.

No external accounts, no API keys.

---

## Features

- **Live build logs.** SSE stream with replay + live tail. Reconnects resume from `Last-Event-ID`; refresh keeps history because logs persist in SQLite.
- **Git URL or upload.** Public Git URLs with a branch picker, or drag-and-dropped folder / `.zip` / `.tar.gz`.
- **Parallel builds.** Configurable `DEPLOYMENT_CONCURRENCY` with an in-process Effect worker pool; runtime-editable from the settings UI.
- **Redeploy and rollback.** Redeploy rebuilds from the same source; rollback creates a new `kind: "rollback"` deployment that reuses an old image tag and switches traffic when healthy.
- **Persistent build cache.** builds for the same project are cached as long as the PaaS is running.
- **Graceful shutdown+Startup reconciliation.** `compose stop_grace_period: 30s` lets the API stop managed containers and update DB state on `SIGTERM`; `down.sh` also stops any leftover deployed containers.
- **Per-app env vars** with `.env`-paste-to-rows, snapshotted immutably onto every deployment.
- **Railpack build/start command overrides** per app, also snapshotted per deploy.
- **Vercel-style hostnames.** Live URLs are `<repo-or-folder>.localhost:<port>`, with a `-<short-id>` suffix on collision; sticky across redeploys.

---

## Architecture

```
   Browser
     │   1. POST /api/deployments       4. GET /api/deployments/:id/logs/stream  (SSE)
     │      via Caddy /api/*               via Caddy /api/*
     ▼                                  ▲
 ┌──────────┐  :8080 ingress            │
 │  Caddy   │◄────────── <slug>.localhost:8080 ── routes patched at deploy time
 └────┬─────┘                           │
      │ /api/*                          │
      ▼                                 │
 ┌──────────────────────────────────────┴──────────┐
 │                    API (Effect, Bun)            │
 │                                                 │
 │   HTTP routes ──► enqueue command in SQLite     │
 │                                                 │
 │   Worker fiber  ──► railpack + docker buildx    │
 │       │                  │                      │
 │       │       stdout/err │ line-by-line         │
 │       │                  ▼                      │
 │       │            ┌───────────────┐            │
 │       │            │ deployment_   │  truth     │
 │       │            │   logs        │◄──── SQLite (WAL)
 │       │            └──────┬────────┘            │
 │       │                   │ INSERT triggers     │
 │       │                   ▼                     │
 │       │            ┌───────────────┐            │
 │       │            │  outbox →     │  wakeup    │
 │       │            │  XADD stream  │─────► Redis Streams
 │       │            └───────────────┘            │
 │                                                 │
 │   SSE handler ◄── XREAD wakeup ◄── Redis        │
 │       │                                         │
 │       │  reads SQLite WHERE sequence > last     │
 │       │  emits each row as `id: <sequence>`     │
 │       ▼                                         │
 │     browser                                     │
 │                                                 │
 │   ── docker run ──► deployed container          │
 │   ── PATCH Caddy admin /config/.../routes       │
 └────┬───────────────────┬────────────────────────┘
      │ docker.sock       │ admin :2019
      ▼                   ▼
   Docker             Caddy admin
```

### Deploy flow

1. UI `POST /api/deployments` with a Git URL or uploaded archive ref.
2. API inserts `apps` (if new), `deployments`, and `deployment_commands` in one SQLite transaction, then publishes a wakeup on Redis Streams.
3. A worker fiber claims the command via `UPDATE … RETURNING` against SQLite.
4. Worker materializes source (shallow `git archive` or archive extraction), runs `railpack prepare`, then `docker buildx build … -f .railpack-plan.json --load -t deployable/<slug>:<deployment-id>`.
5. `docker run` on the shared `deployable` network with `deployable.{app,deployment,managed}` labels. Env vars are snapshotted into `deployment_env_snapshots` and injected.
6. Health probe (`GET /` by Docker DNS, accepts any real HTTP response).
7. Caddy Admin API `PATCH /config/apps/http/servers/srv0/routes` adds `<slug>.localhost → <container>:<port>`.
8. Old container drained, `apps.active_deployment_id` switched, deployment marked `running`.

---

## Stack notes

### Bun for runtime and tooling

The API runs on Bun directly. Bun reads TypeScript without a build step, ships a fast `Bun.spawn` for shelling out to `git`, `railpack`, and `docker`, and parses uploaded archives natively through `FormData` and `File`. The same Bun binary also runs the workspace scripts (`bun install`, `bun typecheck`). The code uses Bun-specific APIs in a few places, so swapping the runtime to Node is not free.

### [Effect](https://effect.website) on the API

The API is built around three things Effect makes easy:

- **Services and layers.** Database access, Docker, Caddy's admin API, Railpack, Redis, source materialization, and deployment orchestration are each defined as a service interface with a separate live layer. Routes and workers depend on the interface; swapping a fake in for tests or a different driver in production is a one-line change.
- **Typed errors.** A function that can fail with `BuildError | DockerRunError` says so in its return type. Forgetting to handle a tag is a compile error, not a 500 in production.
- **Structured concurrency.** Workers, the outbox publisher, and SSE handlers run as fibers. When an SSE client disconnects, the fiber serving them is interrupted, which interrupts every downstream operation it kicked off and runs every cleanup hook on the way out. No manual `AbortController` plumbing, no leaked subscriptions.

The frontend does not use Effect. TanStack Query covers what a one-page UI needs.

### SQLite is the source of truth, Redis is the wakeup layer

The deployment pipeline has three things to coordinate: which worker takes which job, what state each deployment is in, and how live logs reach the browser. All three have to survive a process restart and stay consistent with what users see. The split is straightforward: SQLite (Drizzle, WAL mode) owns durable state, Redis is a notification bus, and nothing leaves SQLite without being written first.

**Schema.**

- `apps` and `deployments` are the read model. `deployments.kind` is either `"build"` or `"rollback"`, so a rollback is just another deployment that happens to reuse an old image tag.
- `deployment_events` is an append-only lifecycle stream (`deployment.created`, `image.build.started`, `traffic.switch.succeeded`, `rollback.started`, and so on). The public status field (`pending → building → deploying → running | failed | stopped`) is a projection of these events, not a free-floating column the worker can race on.
- `deployment_logs` is every stdout/stderr line from `railpack`, `docker buildx`, and `docker run`, indexed by `(deployment_id, sequence)` where `sequence` is monotonic per deployment.
- `deployment_commands` is the worker pool's job table, with `claimed_by` / `claimed_at` so a crashed worker's claims can be reconciled.
- `outbox_events` is a transactional outbox.
- `app_env_vars` and `app_settings` are mutable per app; `deployment_env_snapshots` and `deployment_option_snapshots` are immutable per deployment so a redeploy or rollback never silently picks up new config.

**How jobs get claimed.** When the API accepts a deployment, it inserts `apps` (if new), `deployments`, and `deployment_commands` in one transaction, then pushes a wakeup onto a Redis Stream. Worker fibers blocked on that stream wake up and run `UPDATE deployment_commands SET status='running' … RETURNING` against SQLite. The database itself decides who got the row, so two workers can never claim the same job.

**How log lines reach the browser.** Every log line goes into `deployment_logs` in the same SQLite transaction as a row in `outbox_events`. A publisher fiber drains the outbox and pushes a small `{ deploymentId, sequence }` notification onto a Redis Stream. The SSE handler blocks on that stream, but the notification only tells it "there's new data at sequence N"; the actual payload is read from SQLite and shipped with `id: N`. On reconnect, the browser sends `Last-Event-ID: N` and the handler resumes from there. So: a refresh replays full history from disk, a Redis outage doesn't lose log lines, and live tail can't drift from durable history because both come from the same place.

**Worker pool.** `DEPLOYMENT_WORKER_SLOTS` (default 16) fibers wait on the wakeup queue. Concurrency is gated separately by `DEPLOYMENT_CONCURRENCY` (default 2), runtime-editable in the settings UI; lowering it doesn't kill in-flight deploys, only future claims wait. On startup, a reconciliation pass marks any `deployment_commands.status = 'running'` rows as failed (mid-build resumption isn't supported) and re-syncs Caddy routes from `apps.active_deployment_id`. Crashes are inevitable; silent half-completed deployments are the worst possible UX.

### Caddy is the only ingress

Caddy listens on `:8080` and is the only public port the project exposes. It serves three kinds of traffic:

- `/api/*` to the backend.
- Everything else on the root host to the frontend.
- `<slug>.localhost:8080` to the matching deployed container.

The third route doesn't exist at startup. The API patches it in over [Caddy's admin API](https://caddyserver.com/docs/api) when a deployment goes healthy, and patches it out on shutdown or rollback. Caddy reaches the deployed container by container DNS over the shared `deployable` Docker network, not by a host-published port, so ten apps deployed locally don't fight for ten ports.

The API is never in the data plane. User traffic to a deployed app does not hit Node code at all.

### Railpack builds, the platform deploys

[Railpack](https://railpack.com) is the build tool. It looks at a project, figures out the right base image and install/build commands, and produces a BuildKit plan. That is all it does here.

Everything past "produce an image" is the platform's job: tagging the image, running it on the right network with the right env vars, health-checking it, switching traffic, recording lifecycle events, streaming logs. The worker calls `railpack prepare` to write a plan file, then runs `docker buildx build -f <plan> --load -t deployable/<slug>:<deployment-id>` against that plan. The image lands in the local Docker daemon, ready to run.

The deploy form also calls `railpack info` against the source before submission, so the user sees the detected build and start commands and can override them before the build starts.

### Why the Docker network is declared `external`

When the API receives a deploy command, it shells out to `docker run` over the host's Docker socket. That `docker run` is a sibling process to compose, not a member of the compose project, so it has no idea what compose called the network. An external named network sidesteps this: compose attaches Caddy and the API to it by name, and the worker attaches each new app container to it by the same name. They all see each other by container DNS.

The cost is that the network has to exist before `docker compose up` can start. Hence the one-time `docker network create deployable` in setup.

### One image for the platform, Railpack for everything else

The repo ships two Dockerfiles, both for the platform itself: one builds the API image (Docker CLI, BuildKit, Railpack, Bun, git, tar, unzip, with Railpack's base detection pre-warmed so a first deploy doesn't pay a cold start), one builds the static frontend image. There are no Dockerfiles for user code. Anything submitted through the UI goes through Railpack.

---

## API

| Method          | Path                                | Notes                                                          |
| --------------- | ----------------------------------- | -------------------------------------------------------------- |
| `GET`           | `/health`, `/api/health`            | Liveness                                                       |
| `GET`           | `/api/apps`                         | List                                                           |
| `GET`           | `/api/apps/:id`                     | App + active deployment                                        |
| `PATCH`         | `/api/apps/:id`                     | Rename, change hostname                                        |
| `DELETE`        | `/api/apps/:id`                     | Stops container, removes route, cascades                       |
| `POST`          | `/api/apps/:id/{stop,restart}`      | Graceful stop / restart from existing image                    |
| `POST`          | `/api/apps/:id/{redeploy,rollback}` | New build from source / `kind: "rollback"` reusing old tag     |
| `GET`           | `/api/apps/:id/deployments`         | History                                                        |
| `GET` / `PUT`   | `/api/apps/:id/env`                 | Env vars (redacted in logs)                                    |
| `GET` / `PUT`   | `/api/apps/:id/build-config`        | Railpack `--build-cmd` / `--start-cmd` overrides               |
| `GET`           | `/api/deployments`                  | All deployments across apps                                    |
| `GET`           | `/api/deployments/:id`              | One deployment                                                 |
| `POST`          | `/api/deployments`                  | Create from Git URL or upload archive ref                      |
| `GET`           | `/api/deployments/:id/logs/stream`  | **SSE.** Replay + live tail. `?after=<seq>` or `Last-Event-ID` |
| `POST`          | `/api/source/git/preflight`         | `git ls-remote` for branch picker                              |
| `POST`          | `/api/source/preflight`             | `railpack info` prefill                                        |
| `POST`          | `/api/source/upload`                | `multipart/form-data`, `.zip` or `.tar.gz`                     |
| `GET` / `PATCH` | `/api/settings`                     | `deploymentConcurrency`                                        |

---

## Frontend

One page (`/`) plus a per-project drilldown (`/$projectId`). TanStack Router (file-based) + TanStack Query + Tailwind v4 + a small base-ui-react layer in `apps/web/src/components/ui/`. SSE via native `EventSource`, so no extra deps for log streaming.

What it actually does: Git URL with branch picker (preflight calls `git ls-remote`); drag-and-dropped folder / `.zip` / `.tar.gz` (browser-side zipping via `jszip`); `.env` paste-to-rows in the env editor (handles comments, quoted values, `export KEY=val`); live status chip without polling; logs panel that auto-follows the bottom but disengages when you scroll up; rollback button on every successful past deployment.

---

## Environment variables

You can override the defaults by creating `.env` files:

**Compose** (user-tunable, read by `${VAR:-default}` in `docker-compose.yml`):

| Var             | Default | Notes                                            |
| --------------- | ------- | ------------------------------------------------ |
| `INGRESS_PORT`  | `8080`  | Host port Caddy publishes on (`:80` in-network). |
| `REGISTRY_PORT` | `5000`  | Host port for the local Docker registry.         |

**API** (`apps/api/src/Config/ApiConfig.ts`):

| Var                       | Default                         | Notes                                                               |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `HOST` / `PORT`           | `0.0.0.0` / `4000`              | Bind. Internal wiring; Caddy proxies `/api/*` here.                 |
| `PUBLIC_BASE_URL`         | `http://localhost:8080`         | Origin used in API-emitted URLs. Tune if `INGRESS_PORT` changes.    |
| `DATABASE_PATH`           | `.deployable/deployable.sqlite` | SQLite path. In compose: `/data/deployable.sqlite` bind-mounted.    |
| `REDIS_URL`               | `redis://localhost:6379`        | Internal wiring.                                                    |
| `CADDY_ADMIN_URL`         | `http://localhost:2019`         | Internal wiring.                                                    |
| `DEPLOYMENT_CONCURRENCY`  | `2`                             | Max concurrent deploys; runtime-editable, DB value wins on startup. |
| `DEPLOYMENT_WORKER_SLOTS` | `16`                            | Worker fibers. Usually leave alone.                                 |

**Web** (`apps/web/server/serve.ts` and `vite.config.ts`):

| Var                  | Default                 | Notes                                                                    |
| -------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `HOST` / `PORT`      | `0.0.0.0` / `3000`      | Static server bind. Internal wiring.                                     |
| `VITE_DEV_API_PROXY` | `http://127.0.0.1:4000` | Dev-only `/api/*` proxy upstream.                                        |
| `VITE_API_URL`       | _(unset)_               | Optional client-build origin override; same-origin via Caddy when unset. |

---

## Data directory

Everything writable lives in `tooling/data/`. You can stop compose + leftover deployed containers:

```bash
./down.sh
```

---

## What I'd change with another weekend

In rough priority order:

1. **Real blue/green traffic switch.** Today it's "no traffic loss" (start new, repoint Caddy, then stop old), not truly zero-downtime. A short overlap window using Caddy's load balancing is straightforward.
2. **Batched outbox publisher.** Each log line is a SQLite insert + Redis XADD. BuildKit's `--progress plain` is chatty; group-commit + batch-XADD is the obvious win.
3. **Use the local Docker registry.** It's running but unused; images are `--load`ed into the host daemon. Pushing would enable kill-and-pull-on-demand and map cleanly onto a real registry.
4. **`bun reset:local`** that selectively wipes (SQLite, Redis, Caddy state, workspaces, managed containers + images by label) without `sudo`.
5. **Runtime log tailing.** Schema (`deployment_logs.phase = 'runtime'`) and writer support are in. A `RuntimeLogCollector` attaching to `docker logs -f` after `running` would be ~50 lines.
6. **Auth + multi-tenancy boundary.** `apps` already has the shape; add `owner_id` + middleware.
7. **Auto-create the `deployable` network** in an init container so `docker compose up` is the only setup step.
8. **Persistent build cache**: currently, builds are cached while the PaaS is running. `docker compose down` gets rid of any cache between builds.

---

## Known limitations

- **`/var/run/docker.sock` is mounted into the API container.** essentially root on the host. Fine for a single-node local PaaS, never for production. A real version uses a remote Docker API, a dedicated BuildKit standalone, or job submission to an orchestrator.
- **No isolation or resource limits between deployed containers.**
- **Env vars stored in plaintext SQLite.** A secrets manager in production.
- **No auth.**
- **Workspaces and Railpack artifacts retained forever.** Helps debugging, costs disk. A retention policy is the first cleanup task.
- **Caddy data dir owned by root** (hence `sudo` to wipe). Compose-running-as-non-root is the proper fix.
- **Single-node only.** SQLite is the claim authority; multi-process needs Redis Streams consumer groups, deferred.
