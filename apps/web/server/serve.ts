/**
 * Static file server for the production web bundle.
 *
 * Serves `apps/web/dist/` produced by `vite build`, with SPA fallback so any
 * route that isn't a real file falls through to `index.html` and is handled
 * by TanStack Router on the client.
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const ROOT = join(import.meta.dir, "..", "dist");
const INDEX = join(ROOT, "index.html");

if (!existsSync(INDEX)) {
  console.error(`[web] missing build output at ${ROOT}. Did you run \`bun run build\`?`);
  process.exit(1);
}

function resolveFsPath(urlPath: string): string | null {
  // Strip query/hash + decode + collapse `..`. Reject anything that escapes ROOT.
  const decoded = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!);
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(ROOT, safe);
  if (!candidate.startsWith(ROOT)) return null;
  try {
    const s = statSync(candidate);
    if (s.isFile()) return candidate;
    if (s.isDirectory()) {
      const idx = join(candidate, "index.html");
      if (existsSync(idx)) return idx;
    }
  } catch {
    // not a real file — caller falls back to SPA index
  }
  return null;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const filePath = resolveFsPath(url.pathname);
    if (filePath) {
      const file = Bun.file(filePath);
      // Long-cache hashed assets, never the entry html.
      const isHtml = filePath.endsWith(".html");
      return new Response(file, {
        headers: {
          "cache-control": isHtml
            ? "no-cache, no-store, must-revalidate"
            : "public, max-age=31536000, immutable",
        },
      });
    }
    // SPA fallback.
    return new Response(Bun.file(INDEX), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  },
});

console.log(`[web] serving ${ROOT} on http://${HOST}:${server.port}`);
