import { Effect } from "effect";
import { cast } from "effect/Function";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { type RailpackPreflightInfo, SourceService } from "../../Services/SourceService.ts";

export const gitPreflightRouteLayer = HttpRouter.add(
  "POST",
  "/api/source/git/preflight",
  Effect.gen(function* () {
    const svc = yield* SourceService;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const raw = cast<unknown, Record<string, unknown>>(yield* req.json);
    const url = String(raw.url ?? "");
    const refs = yield* svc.gitLsRemote(url);
    return HttpServerResponse.jsonUnsafe({ refs });
  }),
);

const PREFLIGHT_TMP_ROOT = ".deployable/preflight";
/** TTL on cached preflight results — long enough that toggling refs in the
 *  deploy form is instant, short enough that "I just pushed a new build cmd
 *  to my repo" is reflected next time the user opens the form. */
const PREFLIGHT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const PREFLIGHT_CACHE_MAX = 64;

type CachedPreflight = {
  readonly value: RailpackPreflightInfo;
  readonly expiresAt: number;
};

/** Process-local cache. Keyed by `archivePath` for upload sources and by
 *  `${gitUrl}@${ref}` for git sources. Entries expire after the TTL above
 *  and the oldest entries are evicted past `PREFLIGHT_CACHE_MAX`. */
const preflightCache = new Map<string, CachedPreflight>();

function getCachedPreflight(key: string): RailpackPreflightInfo | null {
  const hit = preflightCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    preflightCache.delete(key);
    return null;
  }
  // LRU touch
  preflightCache.delete(key);
  preflightCache.set(key, hit);
  return hit.value;
}

function putCachedPreflight(key: string, value: RailpackPreflightInfo): void {
  preflightCache.set(key, { value, expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS });
  if (preflightCache.size > PREFLIGHT_CACHE_MAX) {
    const oldest = preflightCache.keys().next().value;
    if (oldest !== undefined) preflightCache.delete(oldest);
  }
}

/** Best-effort recursive remove — used as cleanup for preflight scratch
 *  directories so we never leave half-extracted sources behind. */
function rmrf(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // ignore — these are throwaway scratch dirs
  }
}

/** Run `railpack info` against a freshly extracted upload or a freshly
 *  fetched git ref so the deploy form can prefill its build/start command
 *  fields with the same defaults the actual build would use.
 *
 *  Performance notes:
 *   - Git fetches use the SourceService fast path (HTTPS tarball / `git
 *     archive` / shallow blobless clone, in that order).
 *   - Successful results are cached in-process for `PREFLIGHT_CACHE_TTL_MS`
 *     so toggling between refs in the form is instant on revisits.
 */
export const railpackPreflightRouteLayer = HttpRouter.add(
  "POST",
  "/api/source/preflight",
  Effect.gen(function* () {
    const svc = yield* SourceService;
    const req = yield* HttpServerRequest.HttpServerRequest;
    const raw = cast<unknown, Record<string, unknown>>(yield* req.json);
    const archivePath =
      typeof raw.archivePath === "string" && raw.archivePath.length > 0 ? raw.archivePath : null;
    const gitUrl = typeof raw.gitUrl === "string" && raw.gitUrl.length > 0 ? raw.gitUrl : null;
    const ref = typeof raw.ref === "string" && raw.ref.length > 0 ? raw.ref : "HEAD";

    if (!archivePath && !gitUrl) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Provide either archivePath or gitUrl" },
        { status: 400 },
      );
    }

    const cacheKey = archivePath ? `archive:${archivePath}` : `git:${gitUrl}@${ref}`;
    const cached = getCachedPreflight(cacheKey);
    if (cached) {
      return HttpServerResponse.jsonUnsafe(cached);
    }

    const tmpDir = join(PREFLIGHT_TMP_ROOT, crypto.randomUUID().slice(0, 16));
    mkdirSync(tmpDir, { recursive: true });

    const result = yield* Effect.gen(function* () {
      if (archivePath) {
        yield* svc.extractArchive({ archivePath, targetDir: tmpDir });
      } else if (gitUrl) {
        yield* svc.fetchGitTreeShallow({ url: gitUrl, ref, targetDir: tmpDir });
      }
      return yield* svc.railpackPreflight(tmpDir);
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmrf(tmpDir))),
      Effect.catch((err) =>
        Effect.succeed({
          error: err instanceof Error ? err.message : String(err),
        } as const),
      ),
    );

    if ("error" in result) {
      return HttpServerResponse.jsonUnsafe({ error: result.error }, { status: 502 });
    }
    putCachedPreflight(cacheKey, result);
    return HttpServerResponse.jsonUnsafe(result);
  }),
);

const UPLOAD_DIR = ".deployable/uploads";

export const uploadArchiveRouteLayer = HttpRouter.add(
  "POST",
  "/api/source/upload",
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const nativeReq = (req as unknown as { source: Request }).source;

    const formData = yield* Effect.tryPromise({
      try: () => nativeReq.formData(),
      catch: () => new Error("Failed to parse multipart form data"),
    });

    const file = formData.get("file") as File | null;
    if (!file) {
      return HttpServerResponse.jsonUnsafe({ error: "Missing 'file' field" }, { status: 400 });
    }

    const uploadId = crypto.randomUUID().slice(0, 16);
    const rawName = file.name || `upload-${uploadId}.tar.gz`;
    const isZip = rawName.endsWith(".zip");
    const isTarGz = rawName.endsWith(".tar.gz") || rawName.endsWith(".tgz");
    if (!isZip && !isTarGz) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Only .zip and .tar.gz archives are supported" },
        { status: 400 },
      );
    }
    const filename = rawName;
    const uploadDir = join(UPLOAD_DIR, uploadId);
    mkdirSync(uploadDir, { recursive: true });

    const archivePath = join(uploadDir, filename);
    const buf = yield* Effect.tryPromise({
      try: () => file.arrayBuffer(),
      catch: () => new Error("Failed to read file"),
    });
    writeFileSync(archivePath, Buffer.from(buf));

    return HttpServerResponse.jsonUnsafe(
      { uploadId, filename, archivePath, size: file.size },
      { status: 201 },
    );
  }),
);
