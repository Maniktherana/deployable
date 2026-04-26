import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  FileTextIcon,
  GitBranch,
  Loader2,
  MoreHorizontal,
  PlayCircle,
  RotateCcw,
  ScrollText,
  Settings2,
  StopCircle,
  Trash2,
  Upload,
} from "lucide-react";
import {
  type BuildConfig,
  deleteApp,
  getApp,
  getAppBuildConfig,
  getDeployment,
  listAppDeployments,
  listAppEnv,
  type Deployment,
  type DeploymentStatus,
  redeploy,
  restartApp,
  rollback,
  setAppBuildConfig,
  setAppEnv,
  stopApp,
  updateApp,
} from "#/lib/api";
import { BuildConfigEditor } from "#/components/build-config-editor";
import { ConfirmDialog } from "#/components/confirm-dialog";
import { toastManager } from "#/components/ui/toast";
import { DeploymentLogViewer } from "#/components/deployment-log-viewer";
import {
  EnvVarsEditor,
  type EnvRow,
  makeEmptyRow,
  mapToRows,
  rowsToMap,
} from "#/components/env-vars-editor";
import { Truncate } from "#/components/truncate";
import { Button, buttonVariants } from "#/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "#/components/ui/dialog";
import { Field, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "#/components/ui/menu";
import { Skeleton } from "#/components/ui/skeleton";
import { Drawer, DrawerPopup } from "#/components/ui/drawer";
import { formatRelativeTime, shortId } from "#/lib/format";
import { cn } from "#/lib/utils";

type ProjectSearch = { log?: string };

export const Route = createFileRoute("/$projectId")({
  component: ProjectPage,
  validateSearch: (raw: Record<string, unknown>): ProjectSearch => ({
    log: typeof raw.log === "string" ? raw.log : undefined,
  }),
});

/**
 * Primary, scannable label for a deployment — what shows up as the row's title.
 *  - git: the repo (host + path)
 *  - upload: the uploaded archive's filename
 *  - rollback: a short, unambiguous "Rollback" line referencing the source id
 */
function sourceTitle(d: Deployment): string {
  const s = d.source;
  if (s.type === "git") {
    return s.url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  }
  if (s.type === "upload") {
    return s.filename;
  }
  return `Rollback of ${shortId(s.sourceDeploymentId, 8)}`;
}

/**
 * Secondary metadata line under the title. We deliberately suppress git ref
 * info on rollbacks so users don't think they got a fresh build of `main` —
 * a rollback runs the previously-built image as-is.
 */
type SourceMeta =
  | { kind: "git"; ref: string | null; sha: string | null }
  | { kind: "upload"; rootDirectory: string | null }
  | { kind: "rollback"; sourceDeploymentId: string };

function sourceMeta(d: Deployment): SourceMeta {
  const s = d.source;
  if (s.type === "git") {
    return { kind: "git", ref: s.ref ?? null, sha: s.commitSha ?? null };
  }
  if (s.type === "upload") {
    return { kind: "upload", rootDirectory: s.rootDirectory ?? null };
  }
  return { kind: "rollback", sourceDeploymentId: s.sourceDeploymentId };
}

function getActiveLiveUrl(
  activeId: string | undefined,
  deps: { items: readonly Deployment[] } | undefined,
): string | null {
  if (!activeId || !deps) return null;
  const dep = deps.items.find((x) => x.id === activeId);
  // Only show live link if the deployment is actually running
  if (!dep || dep.status !== "running") return null;
  return dep.liveUrl ?? null;
}

const STATUS_LABEL: Record<DeploymentStatus, string> = {
  running: "Ready",
  failed: "Error",
  building: "Building",
  deploying: "Deploying",
  pending: "Queued",
  stopped: "Stopped",
};

function StatusDot({ status }: { status: DeploymentStatus }) {
  const palette: Record<DeploymentStatus, { dot: string; text: string }> = {
    running: { dot: "bg-emerald-500", text: "text-emerald-400" },
    failed: { dot: "bg-red-500", text: "text-red-400" },
    building: { dot: "bg-sky-500", text: "text-sky-400" },
    deploying: { dot: "bg-indigo-500", text: "text-indigo-400" },
    pending: { dot: "bg-amber-500", text: "text-amber-400" },
    stopped: { dot: "bg-muted-foreground/70", text: "text-muted-foreground" },
  };
  const { dot, text } = palette[status];
  const animate = status === "building" || status === "deploying" || status === "pending";
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className="relative inline-flex size-2 shrink-0">
        {animate && (
          <span
            className={cn("absolute inset-0 animate-ping rounded-full opacity-60", dot)}
            aria-hidden
          />
        )}
        <span className={cn("relative size-2 rounded-full", dot)} aria-hidden />
      </span>
      <span className={cn("font-medium", text)}>{STATUS_LABEL[status]}</span>
    </span>
  );
}

/** Tiny chip describing the *kind* of source: git / upload / rollback. */
function SourceKindChip({ d }: { d: Deployment }) {
  const meta = sourceMeta(d);
  if (meta.kind === "git") {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider">
        <GitBranch className="size-3 opacity-70" aria-hidden />
        Git
      </span>
    );
  }
  if (meta.kind === "upload") {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider">
        <Upload className="size-3 opacity-70" aria-hidden />
        Upload
      </span>
    );
  }
  return (
    <span className="text-amber-400/90 inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider">
      <RotateCcw className="size-3 opacity-80" aria-hidden />
      Rollback
    </span>
  );
}

/**
 * Source-specific secondary line (branch for git, root dir for upload, source
 * deployment id for rollback). Returns null when there's nothing useful to add.
 */
function SourceMetaLine({ d }: { d: Deployment }) {
  const meta = sourceMeta(d);
  if (meta.kind === "git" && meta.ref) {
    return (
      <p className="text-muted-foreground inline-flex max-w-full items-center gap-1 truncate text-xs">
        <GitBranch className="size-3 shrink-0 opacity-70" aria-hidden />
        <Truncate text={meta.ref} className="font-mono">
          {meta.ref}
        </Truncate>
      </p>
    );
  }
  if (meta.kind === "upload" && meta.rootDirectory) {
    return (
      <p className="text-muted-foreground inline-flex max-w-full items-center gap-1 truncate text-xs">
        <FileTextIcon className="size-3 shrink-0 opacity-70" aria-hidden />
        <Truncate text={meta.rootDirectory} className="font-mono">
          {meta.rootDirectory}
        </Truncate>
      </p>
    );
  }
  if (meta.kind === "rollback") {
    return (
      <p className="text-muted-foreground inline-flex max-w-full items-center gap-1 truncate text-xs">
        <RotateCcw className="size-3 shrink-0 opacity-70" aria-hidden />
        <span className="font-mono">from {shortId(meta.sourceDeploymentId, 8)}</span>
      </p>
    );
  }
  return null;
}

function ProjectPage() {
  /** URL segment is `projectId`; the API still calls this the app `id`. */
  const { projectId: appId } = Route.useParams();
  const search = Route.useSearch() as ProjectSearch;
  const navigate = Route.useNavigate();
  const q = useQueryClient();
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [metaHydrated, setMetaHydrated] = useState(false);
  const [saved, setSaved] = useState<"idle" | "ok" | "err">("idle");
  const [projectOpen, setProjectOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [envRows, setEnvRows] = useState<EnvRow[]>([makeEmptyRow()]);
  const envHydratedFor = useRef<string | null>(null);
  const [buildCfg, setBuildCfg] = useState<BuildConfig>({});
  const buildCfgHydratedFor = useRef<string | null>(null);

  const appQ = useQuery({ queryKey: ["app", appId], queryFn: () => getApp(appId) });
  const depsQ = useQuery({
    queryKey: ["deployments", appId],
    queryFn: () => listAppDeployments(appId),
    /**
     * Poll while there's an in-flight deployment so the page reflects
     * Building → Ready / Failed / Stopped without a manual refresh.
     */
    refetchInterval: (query) => {
      const latest = query.state.data?.items[0];
      if (
        latest &&
        (latest.status === "building" ||
          latest.status === "deploying" ||
          latest.status === "pending")
      ) {
        return 2_000;
      }
      return false;
    },
  });

  const envQ = useQuery({
    queryKey: ["env", appId],
    queryFn: () => listAppEnv(appId),
    /** Only fetch when settings dialog is open. */
    enabled: projectOpen,
    /** A failed env fetch shouldn't loop — surface it once and let the user save anyway. */
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Build/start command overrides — fetched on the same trigger as env vars
  // and treated identically: 404 → empty, errors surface once via toast.
  const buildCfgQ = useQuery({
    queryKey: ["build-config", appId],
    queryFn: () => getAppBuildConfig(appId),
    enabled: projectOpen,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const envErrorReportedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!projectOpen) {
      envErrorReportedFor.current = null;
      return;
    }
    if (envQ.isError && envErrorReportedFor.current !== appId) {
      envErrorReportedFor.current = appId;
      toastManager.add({
        type: "error",
        title: "Couldn't load env vars",
        description: envQ.error instanceof Error ? envQ.error.message : "Unknown error",
      });
    }
  }, [projectOpen, envQ.isError, envQ.error, appId]);

  const logId = search.log;
  const logQ = useQuery({
    queryKey: ["deployment", logId],
    queryFn: () => getDeployment(logId!),
    enabled: Boolean(logId),
    /**
     * Poll the open deployment while it's in flight so the drawer header status
     * + log viewer status flip live.
     */
    refetchInterval: (query) => {
      const d = query.state.data;
      if (d && (d.status === "building" || d.status === "deploying" || d.status === "pending")) {
        return 2_000;
      }
      return false;
    },
  });

  /**
   * Track the latest deployment status so we can refetch the app (which owns
   * `activeDeploymentId`) the moment a build leaves an in-flight state.
   */
  const prevLatestStatus = useRef<DeploymentStatus | null>(null);
  useEffect(() => {
    const latest = depsQ.data?.items[0];
    if (!latest) return;
    const wasInFlight =
      prevLatestStatus.current === "building" ||
      prevLatestStatus.current === "deploying" ||
      prevLatestStatus.current === "pending";
    const isInFlight =
      latest.status === "building" || latest.status === "deploying" || latest.status === "pending";
    if (wasInFlight && !isInFlight) {
      void q.invalidateQueries({ queryKey: ["app", appId] });
      if (logId) {
        void q.invalidateQueries({ queryKey: ["deployment", logId] });
      }
    }
    prevLatestStatus.current = latest.status;
  }, [depsQ.data, q, appId, logId]);

  useEffect(() => {
    if (appQ.isSuccess && !metaHydrated) {
      setName(appQ.data.name);
      setHostname(appQ.data.hostname);
      setMetaHydrated(true);
    }
  }, [appQ.isSuccess, appQ.data, metaHydrated]);

  /**
   * Hydrate the env editor when the dialog opens (and re-hydrate if a save
   * triggered an env refetch). Tracking by appId-key prevents the editor's
   * in-progress edits from being clobbered by re-renders.
   */
  useEffect(() => {
    if (!projectOpen) {
      envHydratedFor.current = null;
      return;
    }
    if (envQ.isSuccess && envHydratedFor.current !== appId) {
      const rows = mapToRows(envQ.data.envVars);
      setEnvRows(rows.length > 0 ? rows : [makeEmptyRow()]);
      envHydratedFor.current = appId;
    }
  }, [projectOpen, envQ.isSuccess, envQ.data, appId]);

  useEffect(() => {
    if (!projectOpen) {
      buildCfgHydratedFor.current = null;
      return;
    }
    if (buildCfgQ.isSuccess && buildCfgHydratedFor.current !== appId) {
      setBuildCfg({
        buildCommand: buildCfgQ.data.buildCommand ?? "",
        startCommand: buildCfgQ.data.startCommand ?? "",
      });
      buildCfgHydratedFor.current = appId;
    }
  }, [projectOpen, buildCfgQ.isSuccess, buildCfgQ.data, appId]);

  const doDelete = useMutation({
    mutationFn: () => deleteApp(appId),
    onSuccess: () => {
      void q.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) => {
      toastManager.add({
        type: "error",
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });

  const doStop = useMutation({
    mutationFn: () => stopApp(appId),
    onSuccess: async (a) => {
      q.setQueryData(["app", appId], a);
      // Await so items is fresh before restartableDeployment is recomputed.
      await q.invalidateQueries({ queryKey: ["deployments", appId] });
    },
    onError: (e) => {
      toastManager.add({
        type: "error",
        title: "Stop failed",
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });

  const doRestart = useMutation({
    mutationFn: (deploymentId: string) => restartApp(appId, deploymentId),
    onSuccess: (a) => {
      q.setQueryData(["app", appId], a);
      void q.invalidateQueries({ queryKey: ["deployments", appId] });
    },
    onError: (e) => {
      toastManager.add({
        type: "error",
        title: "Restart failed",
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });

  const doRollback = useMutation({
    mutationFn: (deploymentId: string) => rollback(appId, deploymentId),
    onSuccess: () => {
      void q.invalidateQueries({ queryKey: ["deployments", appId] });
      void q.invalidateQueries({ queryKey: ["app", appId] });
    },
    onError: (e) => {
      toastManager.add({
        type: "error",
        title: "Redeploy failed",
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });

  const doRedeploy = useMutation({
    mutationFn: (deploymentId: string) => redeploy(appId, deploymentId),
    onSuccess: (d) => {
      void q.invalidateQueries({ queryKey: ["deployments", appId] });
      void q.invalidateQueries({ queryKey: ["app", appId] });
      openLogs(d.id);
    },
    onError: (e) => {
      toastManager.add({
        type: "error",
        title: "Rebuild failed",
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });

  const saveMeta = useMutation({
    mutationFn: async () => {
      const a = await updateApp(appId, { name, hostname });
      const env = await setAppEnv(appId, rowsToMap(envRows));
      const cfg = await setAppBuildConfig(appId, {
        // Empty string from the input means "clear the override". The API
        // distinguishes undefined (unchanged) from empty string (clear).
        buildCommand: buildCfg.buildCommand ?? "",
        startCommand: buildCfg.startCommand ?? "",
      });
      return { app: a, envVars: env.envVars, buildConfig: cfg };
    },
    onSuccess: ({ app: a, envVars, buildConfig }) => {
      q.setQueryData(["app", appId], a);
      q.setQueryData(["env", appId], { envVars });
      q.setQueryData(["build-config", appId], buildConfig);
      setSaved("ok");
      setProjectOpen(false);
      setTimeout(() => setSaved("idle"), 2000);
      // Trigger a rebuild so the new env vars take effect (git-sourced only).
      // Pass the active (or latest) deployment id — the backend walks rollback
      // chains back to the original git source itself.
      const allDeps = depsQ.data?.items ?? [];
      const candidateId = a.activeDeploymentId ?? allDeps[0]?.id;
      const candidate = allDeps.find((d) => d.id === candidateId);
      const hasGitSource = allDeps.some((d) => d.source.type === "git");
      if (candidate && hasGitSource) {
        doRedeploy.mutate(candidate.id);
      }
    },
    onError: (e) => {
      setSaved("err");
      toastManager.add({
        type: "error",
        title: "Save failed",
        description: e instanceof Error ? e.message : String(e),
      });
    },
  });

  const openLogs = useCallback(
    (id: string) => {
      void navigate({ search: { log: id } as ProjectSearch, replace: false });
    },
    [navigate],
  );

  const closeLogs = useCallback(() => {
    void navigate({ search: { log: undefined } as ProjectSearch, replace: true });
  }, [navigate]);

  const onDrawerOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeLogs();
      }
    },
    [closeLogs],
  );

  const items: Deployment[] = useMemo(() => {
    if (!depsQ.data) {
      return [];
    }
    return [...depsQ.data.items].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  }, [depsQ.data]);

  const activeDeployment = useMemo<Deployment | null>(() => {
    if (!appQ.data?.activeDeploymentId) {
      return null;
    }
    return items.find((x) => x.id === appQ.data.activeDeploymentId) ?? null;
  }, [items, appQ.data]);

  const projectStatus: DeploymentStatus = useMemo(() => {
    if (activeDeployment) {
      return activeDeployment.status;
    }
    if (items.length === 0) {
      return "pending";
    }
    return items[0]!.status;
  }, [activeDeployment, items]);

  // When the app is stopped, find the best deployment to restart from.
  // Prefer one with an imageTag; fall back to the most recent one overall.
  // Also show restart if stop just succeeded (items may not have refreshed yet).
  const restartableDeployment = useMemo<Deployment | null>(() => {
    if (activeDeployment) return null;
    if (items.length === 0) return null;
    // Only restart from a deployment that successfully built an image (not failed builds)
    return (
      items.find(
        (d) => Boolean(d.imageTag) && (d.status === "stopped" || d.status === "running"),
      ) ?? null
    );
  }, [activeDeployment, items]);

  if (appQ.isLoading) {
    return <Skeleton className="h-32 rounded-lg" />;
  }
  if (appQ.isError) {
    return (
      <p className="text-destructive text-sm">
        {appQ.error instanceof Error ? appQ.error.message : "Error"}
      </p>
    );
  }
  if (!appQ.data) {
    return null;
  }
  const app = appQ.data;
  const visitUrl = getActiveLiveUrl(app.activeDeploymentId, depsQ.data);

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground/90 text-sm">
        <Link className="text-foreground/80 hover:underline" to="/">
          Projects
        </Link>
        <span className="text-border mx-1.5">/</span>
        <span className="text-foreground/50">{app.name}</span>
      </p>

      <div className="border-border/60 bg-card flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border px-4 py-3 shadow-xs sm:px-5 sm:py-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="bg-foreground/5 text-foreground/80 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold tracking-tight">
            {app.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-foreground truncate text-base font-semibold tracking-tight sm:text-lg">
                {app.name}
              </h1>
              <StatusDot status={projectStatus} />
            </div>
            {visitUrl ? (
              <a
                className="text-muted-foreground hover:text-foreground inline-flex max-w-full items-center gap-1 truncate text-xs leading-tight hover:underline sm:text-sm"
                href={visitUrl}
                rel="noreferrer"
                target="_blank"
              >
                <span className="truncate font-mono">{app.hostname}</span>
                <ExternalLinkIcon className="size-3 shrink-0 opacity-60" />
              </a>
            ) : (
              <span className="text-muted-foreground/60 inline-flex max-w-full items-center gap-1 truncate text-xs leading-tight sm:text-sm">
                <span className="truncate font-mono">{app.hostname}</span>
              </span>
            )}
            {items.length > 0 && (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <SourceKindChip d={activeDeployment ?? items[0]!} />
                <span className="text-border/80" aria-hidden>
                  ·
                </span>
                <Truncate
                  text={sourceTitle(activeDeployment ?? items[0]!)}
                  className="text-muted-foreground/90 font-mono text-xs"
                />
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {visitUrl && (
            <a
              className={buttonVariants({ size: "sm", variant: "default" })}
              href={visitUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon className="size-3.5" />
              Visit
            </a>
          )}
          {app.activeDeploymentId && (
            <Button
              disabled={doStop.isPending}
              onClick={() => setStopOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              {doStop.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <StopCircle className="size-3.5" />
              )}
              {doStop.isPending ? "Stopping…" : "Stop"}
            </Button>
          )}
          {!app.activeDeploymentId && restartableDeployment && (
            <Button
              disabled={doRestart.isPending}
              onClick={() => doRestart.mutate(restartableDeployment.id)}
              size="sm"
              type="button"
              variant="outline"
            >
              {doRestart.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <PlayCircle className="size-3.5" />
              )}
              {doRestart.isPending ? "Starting…" : "Restart"}
            </Button>
          )}
          <Button onClick={() => setProjectOpen(true)} size="sm" type="button" variant="outline">
            <Settings2 className="size-3.5" />
            Settings
          </Button>
        </div>
      </div>

      {activeDeployment && (
        <div className="border-emerald-500/25 bg-emerald-500/[0.04] flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3 sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
              <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
              Active
            </span>
            <div className="min-w-0">
              <Truncate
                text={sourceTitle(activeDeployment)}
                className="text-foreground font-mono text-sm font-medium"
              />
              <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <SourceKindChip d={activeDeployment} />
                <span className="text-border" aria-hidden>
                  ·
                </span>
                <span title={activeDeployment.updatedAt}>
                  updated {formatRelativeTime(activeDeployment.updatedAt)}
                </span>
                {activeDeployment.imageTag && (
                  <>
                    <span className="text-border" aria-hidden>
                      ·
                    </span>
                    <Truncate
                      text={activeDeployment.imageTag}
                      className="text-muted-foreground/90 max-w-[20rem] font-mono"
                    />
                  </>
                )}
              </div>
            </div>
          </div>
          <Button
            onClick={() => openLogs(activeDeployment.id)}
            size="sm"
            type="button"
            variant="outline"
          >
            <ScrollText className="size-3.5" />
            View logs
          </Button>
        </div>
      )}

      <div>
        <div className="text-muted-foreground mb-3 flex items-baseline justify-between gap-2 text-xs">
          <span className="text-foreground/90 text-sm font-medium">Deployments</span>
          {depsQ.isSuccess && <span className="tabular-nums">{items.length} total</span>}
        </div>
        <div className="border-border/60 bg-card overflow-hidden rounded-xl border shadow-xs">
          {depsQ.isLoading && (
            <div className="p-6 text-center text-muted-foreground text-sm">Loading</div>
          )}
          {depsQ.isError && (
            <div className="p-6 text-center text-destructive text-sm">Failed to load</div>
          )}
          {depsQ.isSuccess &&
            (items.length === 0 ? (
              <p className="p-8 text-center text-muted-foreground text-sm">
                No deployments yet. Start a project from the projects page.
              </p>
            ) : (
              <ul className="divide-border/50 divide-y">
                {items.map((d) => {
                  const canRedeploy = Boolean(d.imageTag) && d.id !== app.activeDeploymentId;
                  const canRebuild = d.source.type === "git" || d.source.type === "rollback";
                  const isCurrent = d.id === app.activeDeploymentId;
                  return (
                    <li
                      className={cn(
                        "group hover:bg-muted/30 cursor-pointer transition-colors",
                        "focus-visible:outline-none focus-visible:bg-muted/30",
                      )}
                      key={d.id}
                      onClick={() => openLogs(d.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openLogs(d.id);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open logs for deployment ${shortId(d.id, 10)}`}
                    >
                      <div className="grid w-full min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4">
                        {/* col 1: source title + kind chip */}
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <Truncate
                              text={sourceTitle(d)}
                              className="text-foreground font-mono text-sm font-medium"
                            />
                            {isCurrent && (
                              <span className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                                Current
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2">
                            <SourceKindChip d={d} />
                            <SourceMetaLine d={d} />
                          </div>
                        </div>
                        {/* col 2: status + short id */}
                        <div className="min-w-0">
                          <StatusDot status={d.status} />
                          <p
                            className="text-muted-foreground/70 mt-0.5 font-mono text-xs"
                            title={d.id}
                          >
                            {shortId(d.id, 10)}
                          </p>
                        </div>
                        {/* col 3: image tag */}
                        <div className="min-w-0">
                          {d.imageTag ? (
                            <>
                              <p className="text-muted-foreground/60 mb-0.5 text-[10px] uppercase tracking-wide">
                                {d.kind === "rollback" ? "reused image" : "image"}
                              </p>
                              <Truncate
                                text={d.imageTag}
                                className="text-foreground/80 font-mono text-xs"
                              />
                            </>
                          ) : (
                            <p className="text-muted-foreground/70 text-xs italic">
                              {d.status === "failed" || d.status === "stopped"
                                ? "no image"
                                : "building image…"}
                            </p>
                          )}
                        </div>
                        {/* col 4: time + external link + menu */}
                        <div
                          className="flex items-center gap-0.5"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <span
                            className="text-muted-foreground/70 tabular-nums text-xs"
                            title={d.updatedAt}
                          >
                            {formatRelativeTime(d.updatedAt)}
                          </span>
                          {d.liveUrl && (
                            <a
                              className={cn(
                                buttonVariants({ size: "icon-xs", variant: "ghost" }),
                                "text-muted-foreground hover:text-foreground",
                              )}
                              href={d.liveUrl}
                              rel="noreferrer"
                              target="_blank"
                              title="Open deployment URL"
                            >
                              <ExternalLinkIcon className="size-3.5" />
                              <span className="sr-only">Open URL</span>
                            </a>
                          )}
                          <Menu>
                            <MenuTrigger>
                              <Button size="icon-xs" type="button" variant="ghost">
                                <span className="sr-only">Deployment actions</span>
                                <MoreHorizontal className="text-muted-foreground/80 size-4" />
                              </Button>
                            </MenuTrigger>
                            <MenuPopup align="end" side="bottom" sideOffset={4}>
                              <MenuItem onClick={() => openLogs(d.id)}>
                                <ScrollText className="size-3.5" />
                                Open logs
                              </MenuItem>
                              {d.liveUrl && (
                                <MenuItem
                                  onClick={() => {
                                    if (d.liveUrl) {
                                      window.open(d.liveUrl, "_blank", "noopener,noreferrer");
                                    }
                                  }}
                                >
                                  <ExternalLinkIcon className="size-3.5" />
                                  Visit deployment
                                </MenuItem>
                              )}
                              {canRedeploy && (
                                <MenuItem
                                  onClick={() => {
                                    if (!doRollback.isPending) {
                                      doRollback.mutate(d.id);
                                    }
                                  }}
                                >
                                  <RotateCcw className="size-3.5" />
                                  {doRollback.isPending ? "…" : "Redeploy this image"}
                                </MenuItem>
                              )}
                              {canRebuild && (
                                <MenuItem
                                  onClick={() => {
                                    if (!doRedeploy.isPending) {
                                      doRedeploy.mutate(d.id);
                                    }
                                  }}
                                >
                                  <RotateCcw className="size-3.5" />
                                  {doRedeploy.isPending ? "…" : "Rebuild from source"}
                                </MenuItem>
                              )}
                              {d.imageTag && (
                                <MenuItem
                                  onClick={() => {
                                    if (d.imageTag) {
                                      void navigator.clipboard.writeText(d.imageTag);
                                    }
                                  }}
                                >
                                  Copy OCI image ref
                                </MenuItem>
                              )}
                              <MenuItem
                                onClick={() => {
                                  void navigator.clipboard.writeText(d.id);
                                }}
                              >
                                Copy deployment id
                              </MenuItem>
                            </MenuPopup>
                          </Menu>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ))}
        </div>
      </div>

      <Dialog onOpenChange={setProjectOpen} open={projectOpen}>
        <DialogPopup className="w-full max-w-xl">
          <DialogHeader>
            <DialogTitle>Project settings</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-5 px-6 pb-6">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                onChange={(e) => {
                  setName(e.currentTarget.value);
                  setSaved("idle");
                }}
                value={name}
              />
            </Field>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-foreground text-sm font-medium">Environment variables</p>
                {envQ.isFetching && <span className="text-muted-foreground text-xs">Loading…</span>}
              </div>
              <p className="text-muted-foreground/80 text-xs">
                Applied at build and runtime. Saving here takes effect on the next deployment.
              </p>
              <EnvVarsEditor
                disabled={envQ.isFetching || saveMeta.isPending}
                onChange={(rows) => {
                  setEnvRows(rows);
                  setSaved("idle");
                }}
                rows={envRows}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-foreground text-sm font-medium">Build & start commands</p>
                {buildCfgQ.isFetching && (
                  <span className="text-muted-foreground text-xs">Loading…</span>
                )}
              </div>
              <p className="text-muted-foreground/80 text-xs">
                Override railpack&apos;s auto-detected commands. Leave empty to keep the default.
              </p>
              <BuildConfigEditor
                compact
                disabled={buildCfgQ.isFetching || saveMeta.isPending}
                onChange={(next) => {
                  setBuildCfg(next);
                  setSaved("idle");
                }}
                value={buildCfg}
              />
            </div>

            {saved === "ok" && <p className="text-success-foreground/90 text-xs">Saved</p>}

            <div className="border-border/60 flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <Button
                disabled={doDelete.isPending}
                onClick={() => setDeleteOpen(true)}
                type="button"
                variant="destructive"
              >
                <Trash2 className="size-3.5" />
                {doDelete.isPending ? "Deleting…" : "Delete project"}
              </Button>
              <div className="ms-auto flex gap-2">
                <Button
                  onClick={() => {
                    setProjectOpen(false);
                  }}
                  type="button"
                  variant="outline"
                >
                  Close
                </Button>
                <Button
                  disabled={saveMeta.isPending}
                  onClick={() => saveMeta.mutate()}
                  type="button"
                >
                  {saveMeta.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="Stop deployment?"
        description="Are you sure you wish to stop this deployment? The site will go offline immediately."
        confirmLabel="Stop deployment"
        variant="destructive"
        onConfirm={() => doStop.mutate()}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${app.name}"?`}
        description={
          app.activeDeploymentId
            ? "This project has an active deployment. Deleting it will stop the running container and permanently remove all deployment history. This cannot be undone."
            : "All deployment history will be permanently removed. This cannot be undone."
        }
        confirmLabel={doDelete.isPending ? "Deleting…" : "Delete project"}
        variant="destructive"
        loading={doDelete.isPending}
        onConfirm={() => {
          void doDelete.mutateAsync().then(() => {
            setDeleteOpen(false);
            void q.invalidateQueries({ queryKey: ["apps"] });
            location.assign("/");
          });
        }}
      />

      <Drawer onOpenChange={onDrawerOpenChange} open={Boolean(logId)} position="bottom">
        <DrawerPopup
          className="border-border h-[min(72vh,680px)] overflow-hidden"
          position="bottom"
        >
          {logId && (
            <DeploymentLogViewer
              deploymentId={logId}
              deployment={logQ.isSuccess ? logQ.data : undefined}
              onClose={closeLogs}
            />
          )}
        </DrawerPopup>
      </Drawer>
    </div>
  );
}
