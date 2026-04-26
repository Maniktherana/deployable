/** Mirror of apps/api deployment domain; kept loose for forward compatibility. */

export type App = {
  id: string;
  name: string;
  slug: string;
  hostname: string;
  activeDeploymentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentSource =
  | {
      type: "git";
      url: string;
      ref?: string;
      refKind?: "branch" | "tag";
      commitSha?: string;
    }
  | {
      type: "upload";
      filename: string;
      rootDirectory?: string;
    }
  | { type: "rollback"; sourceDeploymentId: string };

export type DeploymentStatus =
  | "pending"
  | "building"
  | "deploying"
  | "running"
  | "stopped"
  | "failed";

export type Deployment = {
  id: string;
  appId: string;
  kind: "build" | "rollback";
  source: DeploymentSource;
  status: DeploymentStatus;
  imageTag?: string;
  liveUrl?: string;
  containerId?: string;
  rollbackSourceDeploymentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentLogEvent = {
  deploymentId: string;
  sequence: number;
  phase: "prepare" | "build" | "deploy" | "runtime";
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
};

export type GitRemoteRef = {
  ref: string;
  sha: string;
  type: "branch" | "tag" | "other";
};

export type EnvVarMap = Record<string, string>;

export type BuildConfig = {
  buildCommand?: string;
  startCommand?: string;
};

export type RailpackPreflightResult = {
  detectedProvider?: string;
  buildCommand?: string;
  startCommand?: string;
};

export type CreateDeploymentInput =
  | {
      sourceType: "git";
      gitUrl: string;
      ref?: string;
      refKind?: "branch" | "tag";
      appId?: string;
      appName?: string;
      envVars?: EnvVarMap;
      buildCommand?: string;
      startCommand?: string;
    }
  | {
      sourceType: "upload";
      filename: string;
      rootDirectory?: string;
      appId?: string;
      appName?: string;
      envVars?: EnvVarMap;
      buildCommand?: string;
      startCommand?: string;
    };

/**
 * Resolve where API requests should go.
 *
 * Priority:
 *   1. `VITE_API_URL` — full origin (e.g. `http://localhost:4000`). Used in
 *      vite dev when the API is on a different host:port. Kept for back
 *      compat with existing local-dev setups.
 *   2. `VITE_API_BASE_URL` — same-origin path prefix (e.g. `/api`) for
 *      compose/prod where Caddy proxies `/api/*`. Setting this to ANY value
 *      means "use same origin"; our helpers already prefix `/api/...`.
 *   3. Default: same-origin (`""`). When the bundle is served from Caddy on
 *      :8080 this proxies cleanly to the api container. When served from
 *      vite on :3000/:5173, vite.config.ts proxies `/api/*` to the host bun
 *      on :4000.
 */
function getBaseUrl(): string {
  const env = import.meta.env;
  const explicit = env.VITE_API_URL;
  if (explicit && /^https?:\/\//i.test(explicit)) {
    return explicit.replace(/\/$/, "");
  }
  return "";
}

export function getApiBaseUrl(): string {
  return getBaseUrl();
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text) as { error?: string; message?: string };
      detail = j.error ?? j.message ?? text;
    } catch {
      // ignore
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return res.json() as Promise<T>;
}

export async function listApps(): Promise<{ items: App[] }> {
  return requestJson("/api/apps");
}

export async function getApp(appId: string): Promise<App> {
  return requestJson(`/api/apps/${encodeURIComponent(appId)}`);
}

export async function updateApp(
  appId: string,
  body: { name?: string; hostname?: string },
): Promise<App> {
  return requestJson(`/api/apps/${encodeURIComponent(appId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteApp(appId: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/apps/${encodeURIComponent(appId)}`, {
    method: "DELETE",
  });
}

export async function stopApp(appId: string): Promise<App> {
  return requestJson(`/api/apps/${encodeURIComponent(appId)}/stop`, {
    method: "POST",
  });
}

export async function listAppEnv(appId: string): Promise<{ envVars: EnvVarMap }> {
  // A 404 here means the app simply has no env entries yet (or the row hasn't
  // been seeded). Treat it as an empty map instead of an error so the settings
  // dialog can render its editor cleanly.
  const url = `${getBaseUrl()}/api/apps/${encodeURIComponent(appId)}/env`;
  const res = await fetch(url, { headers: { "content-type": "application/json" } });
  if (res.status === 404) return { envVars: {} };
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text) as { error?: string; message?: string };
      detail = j.error ?? j.message ?? text;
    } catch {
      // ignore
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as { envVars: EnvVarMap };
}

export async function setAppEnv(
  appId: string,
  envVars: EnvVarMap,
): Promise<{ envVars: EnvVarMap }> {
  return requestJson(`/api/apps/${encodeURIComponent(appId)}/env`, {
    method: "PUT",
    body: JSON.stringify({ envVars }),
  });
}

export async function getAppBuildConfig(appId: string): Promise<BuildConfig> {
  // Treat 404 as "no overrides yet" — the same convention we use for env
  // vars. Keeps the settings dialog quiet for fresh projects.
  const url = `${getBaseUrl()}/api/apps/${encodeURIComponent(appId)}/build-config`;
  const res = await fetch(url, { headers: { "content-type": "application/json" } });
  if (res.status === 404) return {};
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const j = JSON.parse(text) as { error?: string; message?: string };
      detail = j.error ?? j.message ?? text;
    } catch {
      // ignore
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as BuildConfig;
}

export async function setAppBuildConfig(appId: string, body: BuildConfig): Promise<BuildConfig> {
  return requestJson(`/api/apps/${encodeURIComponent(appId)}/build-config`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** All deployments for a single project (app). */
export async function listAppDeployments(appId: string): Promise<{ items: Deployment[] }> {
  return requestJson(`/api/apps/${encodeURIComponent(appId)}/deployments`);
}

/** Every deployment in the system (unscoped). The UI only uses this if you add an admin / global list. */
export async function listDeployments(): Promise<{ items: Deployment[] }> {
  return requestJson("/api/deployments");
}

export async function getDeployment(deploymentId: string): Promise<Deployment> {
  return requestJson(`/api/deployments/${encodeURIComponent(deploymentId)}`);
}

export async function createDeployment(input: CreateDeploymentInput): Promise<Deployment> {
  return requestJson("/api/deployments", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function rollback(appId: string, deploymentId: string): Promise<Deployment> {
  return requestJson(`/api/apps/${encodeURIComponent(appId)}/rollback`, {
    method: "POST",
    body: JSON.stringify({ deploymentId }),
  });
}

export async function restartApp(appId: string, deploymentId: string): Promise<App> {
  return requestJson(`/api/apps/${encodeURIComponent(appId)}/restart`, {
    method: "POST",
    body: JSON.stringify({ deploymentId }),
  });
}

export async function redeploy(appId: string, deploymentId: string): Promise<Deployment> {
  return requestJson(`/api/apps/${encodeURIComponent(appId)}/redeploy`, {
    method: "POST",
    body: JSON.stringify({ deploymentId }),
  });
}

export async function gitPreflight(url: string): Promise<{ refs: GitRemoteRef[] }> {
  return requestJson("/api/source/git/preflight", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

/** Run `railpack info` against an uploaded archive (post-upload) or a git
 *  url so the deploy form can pre-fill build/start command overrides with
 *  the same defaults the build pipeline would have used. Failures are
 *  surfaced to the caller; the caller decides whether to swallow them
 *  (the form should — preflight is best-effort UX). */
export async function railpackPreflight(
  input: { archivePath: string } | { gitUrl: string; ref?: string },
): Promise<RailpackPreflightResult> {
  return requestJson("/api/source/preflight", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function uploadSourceArchive(file: File): Promise<{
  uploadId: string;
  filename: string;
  archivePath: string;
  size: number;
}> {
  const form = new FormData();
  form.set("file", file, file.name);
  const res = await fetch(`${getBaseUrl()}/api/source/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  return res.json() as Promise<{
    uploadId: string;
    filename: string;
    archivePath: string;
    size: number;
  }>;
}

export type Settings = {
  deploymentConcurrency: number;
};

export async function getSettings(): Promise<Settings> {
  return requestJson("/api/settings");
}

export async function patchSettings(body: { deploymentConcurrency?: number }): Promise<Settings> {
  return requestJson("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deploymentLogStreamUrl(deploymentId: string): string {
  return `${getBaseUrl()}/api/deployments/${encodeURIComponent(deploymentId)}/logs/stream`;
}
