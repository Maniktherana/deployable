import { Effect } from "effect";
import { cast } from "effect/Function";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { SourceService } from "../../Services/SourceService.ts";
import { getCachedPreflight, putCachedPreflight } from "./preflightCache.ts";

const PREFLIGHT_TMP_ROOT = ".deployable/preflight";
const UPLOAD_DIR = ".deployable/uploads";

function rmrf(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // scratch dirs; ignore
  }
}

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
