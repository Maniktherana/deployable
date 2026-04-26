import { Context, Data, Effect, Layer } from "effect";

export class GitPreflightError extends Data.TaggedError("GitPreflightError")<{
  readonly message: string;
}> {}

export class GitCloneError extends Data.TaggedError("GitCloneError")<{
  readonly message: string;
}> {}

export class ArchiveExtractError extends Data.TaggedError("ArchiveExtractError")<{
  readonly message: string;
}> {}

export interface GitRemoteRef {
  readonly ref: string;
  readonly sha: string;
  readonly type: "branch" | "tag" | "other";
}

export class DirectoryCopyError extends Data.TaggedError("DirectoryCopyError")<{
  readonly message: string;
}> {}

export class RailpackPreflightError extends Data.TaggedError("RailpackPreflightError")<{
  readonly message: string;
}> {}

export interface RailpackPreflightInfo {
  readonly detectedProvider?: string;
  readonly buildCommand?: string;
  readonly startCommand?: string;
}

export interface SourceServiceShape {
  readonly gitLsRemote: (url: string) => Effect.Effect<GitRemoteRef[], GitPreflightError>;
  readonly gitShallowClone: (opts: {
    url: string;
    ref: string;
    targetDir: string;
  }) => Effect.Effect<void, GitCloneError>;
  readonly extractArchive: (opts: {
    archivePath: string;
    targetDir: string;
  }) => Effect.Effect<void, ArchiveExtractError>;
  readonly copyDirFiltered: (opts: {
    srcDir: string;
    targetDir: string;
  }) => Effect.Effect<void, DirectoryCopyError>;
  readonly prepareSourceDir: (deploymentId: string) => Effect.Effect<string>;
  readonly cleanupSourceDir: (deploymentId: string) => Effect.Effect<void>;
  readonly railpackPreflight: (
    sourceDir: string,
  ) => Effect.Effect<RailpackPreflightInfo, RailpackPreflightError>;
  readonly fetchGitTreeShallow: (opts: {
    url: string;
    ref: string;
    targetDir: string;
  }) => Effect.Effect<void, GitCloneError>;
  readonly prewarmRailpack: () => Effect.Effect<void>;
}

export class SourceService extends Context.Service<SourceService, SourceServiceShape>()(
  "@deployable/api/Services/SourceService",
) {}

const SOURCES_ROOT = ".deployable/sources";
const ARCHIVE_NOISE = new Set(["pax_global_header", ".DS_Store", "__MACOSX"]);

function parseRefType(refName: string): GitRemoteRef["type"] {
  if (refName.startsWith("refs/heads/")) return "branch";
  if (refName.startsWith("refs/tags/")) return "tag";
  return "other";
}

function stripRefPrefix(refName: string): string {
  if (refName.startsWith("refs/heads/")) return refName.slice("refs/heads/".length);
  if (refName.startsWith("refs/tags/")) return refName.slice("refs/tags/".length);
  return refName;
}

// Many archive sources (GitHub "Download ZIP", `git archive`, `tar czvf foo.tgz some-folder/`)
// wrap their contents in a single top-level directory; railpack expects files at the root.
async function flattenSingleTopDir(dir: string): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const significant = entries.filter((e) => !ARCHIVE_NOISE.has(e));
  if (significant.length !== 1) return;
  const only = significant[0]!;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(path.join(dir, only));
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;

  const innerDir = path.join(dir, only);
  const innerEntries = await fs.readdir(innerDir);
  for (const name of innerEntries) {
    await fs.rename(path.join(innerDir, name), path.join(dir, name));
  }
  await fs.rmdir(innerDir).catch(() => {});
  for (const e of entries) {
    if (e !== only && ARCHIVE_NOISE.has(e)) {
      await fs.rm(path.join(dir, e), { recursive: true, force: true }).catch(() => {});
    }
  }
}

function tarballUrlForGitRef(rawUrl: string, ref: string): string | null {
  let url = rawUrl.trim();
  const scp = url.match(/^git@([^:]+):(.+)$/);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts as [string, string];
  const safeRef = encodeURIComponent(ref);
  if (host === "github.com" || host.endsWith(".github.com")) {
    return `https://codeload.github.com/${owner}/${repo}/tar.gz/${safeRef}`;
  }
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) {
    return `https://gitlab.com/${owner}/${repo}/-/archive/${safeRef}/${repo}-${safeRef}.tar.gz`;
  }
  if (host === "codeberg.org" || host === "gitea.com") {
    return `https://${host}/${owner}/${repo}/archive/${safeRef}.tar.gz`;
  }
  return null;
}

function parseGitLsRemoteOutput(stdout: string): GitRemoteRef[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [sha, refName] = line.split("\t") as [string, string];
      return {
        sha: sha.trim(),
        ref: stripRefPrefix(refName.trim()),
        type: parseRefType(refName.trim()),
      };
    });
}

export const SourceServiceLive = Layer.succeed(SourceService, {
  gitLsRemote: (url) =>
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["git", "ls-remote", url], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (exitCode !== 0) {
          throw new Error(stderr || `git ls-remote exited with code ${exitCode}`);
        }
        return parseGitLsRemoteOutput(stdout);
      },
      catch: (cause) =>
        new GitPreflightError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),

  gitShallowClone: ({ url, ref, targetDir }) =>
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["git", "clone", "--depth", "1", "--branch", ref, url, targetDir], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(stderr || `git clone exited with code ${exitCode}`);
        }
      },
      catch: (cause) =>
        new GitCloneError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),

  extractArchive: ({ archivePath, targetDir }) =>
    Effect.tryPromise({
      try: async () => {
        await Bun.spawn(["mkdir", "-p", targetDir]).exited;
        const isZip = archivePath.endsWith(".zip");
        const cmd = isZip
          ? ["unzip", "-o", "-q", archivePath, "-d", targetDir]
          : ["tar", "-xzf", archivePath, "-C", targetDir];
        const spawnExtract = () => {
          try {
            return Bun.spawn(cmd, { stdout: "pipe" as const, stderr: "pipe" as const });
          } catch (cause) {
            const tool = cmd[0];
            const msg = cause instanceof Error ? cause.message : String(cause);
            throw new Error(
              tool === "unzip"
                ? `unable to extract .zip archive: '${tool}' is not installed in the API runtime (${msg})`
                : `unable to extract archive with '${tool}': ${msg}`,
              { cause },
            );
          }
        };
        const proc = spawnExtract();
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(stderr || `archive extract exited with code ${exitCode}`);
        }

        await flattenSingleTopDir(targetDir);
      },
      catch: (cause) =>
        new ArchiveExtractError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),

  copyDirFiltered: ({ srcDir, targetDir }) =>
    Effect.tryPromise({
      try: async () => {
        await Bun.spawn(["mkdir", "-p", targetDir]).exited;
        const src = srcDir.endsWith("/") ? srcDir : `${srcDir}/`;
        const proc = Bun.spawn(
          ["rsync", "-a", "--filter=:- .gitignore", "--exclude=.git", src, targetDir],
          { stdout: "pipe", stderr: "pipe" },
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(stderr || `rsync exited with code ${exitCode}`);
        }
      },
      catch: (cause) =>
        new DirectoryCopyError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),

  prepareSourceDir: (deploymentId) =>
    Effect.tryPromise(async () => {
      const dir = `${SOURCES_ROOT}/${deploymentId}`;
      await Bun.spawn(["mkdir", "-p", dir]).exited;
      return dir;
    }),

  cleanupSourceDir: (deploymentId) =>
    Effect.tryPromise(async () => {
      const dir = `${SOURCES_ROOT}/${deploymentId}`;
      await Bun.spawn(["rm", "-rf", dir]).exited;
    }),

  fetchGitTreeShallow: ({ url, ref, targetDir }) =>
    Effect.tryPromise({
      try: async () => {
        await Bun.spawn(["mkdir", "-p", targetDir]).exited;
        const tarballUrl = tarballUrlForGitRef(url, ref);
        if (tarballUrl) {
          const res = await fetch(tarballUrl, { redirect: "follow" });
          if (res.ok && res.body) {
            const proc = Bun.spawn(["tar", "-xzf", "-", "-C", targetDir], {
              stdin: res.body,
              stdout: "pipe",
              stderr: "pipe",
            });
            const exitCode = await proc.exited;
            if (exitCode === 0) {
              await flattenSingleTopDir(targetDir);
              return;
            }
          }
        }
        const proc = Bun.spawn(
          ["git", "clone", "--depth", "1", "--filter=blob:none", "--branch", ref, url, targetDir],
          {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(stderr || `git clone exited with code ${exitCode}`);
        }
      },
      catch: (cause) =>
        new GitCloneError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),

  railpackPreflight: (sourceDir) =>
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["railpack", "info", sourceDir, "--format", "json"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(stderr || `railpack info exited with code ${exitCode}`);
        }
        const parsed = JSON.parse(stdout) as {
          plan?: {
            steps?: Array<{ name?: string; commands?: Array<{ cmd?: string }> }>;
            deploy?: { startCommand?: string };
          };
          detectedProviders?: string[];
        };
        // last cmd is the actual build (multi-step providers, e.g. yarn workspaces)
        const buildStep = parsed.plan?.steps?.find((s) => s.name === "build");
        const buildCmd = buildStep?.commands
          ?.filter((c) => typeof c.cmd === "string" && c.cmd.length > 0)
          .map((c) => c.cmd as string)
          .at(-1);
        return {
          detectedProvider: parsed.detectedProviders?.[0],
          buildCommand: buildCmd,
          startCommand: parsed.plan?.deploy?.startCommand,
        } satisfies RailpackPreflightInfo;
      },
      catch: (cause) =>
        new RailpackPreflightError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }),

  prewarmRailpack: () =>
    Effect.sync(() => {
      // Pays the ~15s mise cold-start once, off the main fiber, so the first user-facing preflight is fast.
      void (async () => {
        const fs = await import("fs");
        const root = "/tmp/deployable-prewarm";
        try {
          fs.mkdirSync(`${root}/node`, { recursive: true });
          fs.writeFileSync(
            `${root}/node/package.json`,
            '{"name":"prewarm","engines":{"node":">=18"}}\n',
          );
          fs.mkdirSync(`${root}/python`, { recursive: true });
          fs.writeFileSync(`${root}/python/requirements.txt`, "flask\n");
          for (const dir of [`${root}/node`, `${root}/python`]) {
            const proc = Bun.spawn(["railpack", "info", dir, "--format", "json"], {
              stdout: "pipe",
              stderr: "pipe",
            });
            await proc.exited;
          }
        } catch {
          // ignore
        } finally {
          try {
            fs.rmSync(root, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      })();
    }),
});
