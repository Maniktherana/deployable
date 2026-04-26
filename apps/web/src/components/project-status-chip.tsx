import type { App, Deployment, DeploymentStatus } from "#/lib/api";
import { cn } from "#/lib/utils";

export type RowStatus =
  | { kind: "ready" }
  | { kind: "in_flight"; status: DeploymentStatus }
  | { kind: "failed" }
  | { kind: "stopped" }
  | { kind: "idle" };

const IN_FLIGHT_STATUSES = new Set<DeploymentStatus>(["pending", "building", "deploying"]);

export function isInFlight(status: DeploymentStatus | undefined | null): boolean {
  return status != null && IN_FLIGHT_STATUSES.has(status);
}

/**
 * Derives the display status for a project row from the app and (optionally) its
 * deployments. Prefers the latest deployment's status when it's in flight so the
 * row reflects an in-progress build even before `activeDeploymentId` is updated.
 */
export function rowStatusFor(app: App, deps: readonly Deployment[] | undefined): RowStatus {
  if (!deps || deps.length === 0) {
    return app.activeDeploymentId ? { kind: "ready" } : { kind: "idle" };
  }
  const latest = [...deps].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  )[0]!;
  if (isInFlight(latest.status)) {
    return { kind: "in_flight", status: latest.status };
  }
  if (app.activeDeploymentId || latest.status === "running") {
    return { kind: "ready" };
  }
  if (latest.status === "failed") return { kind: "failed" };
  if (latest.status === "stopped") return { kind: "stopped" };
  return { kind: "idle" };
}

type ChipStyle = { label: string; chip: string; dot: string; pulse?: boolean };

const STATUS_CHIP: Record<RowStatus["kind"] | DeploymentStatus, ChipStyle> = {
  ready: {
    label: "Ready",
    chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    dot: "bg-emerald-500",
  },
  building: {
    label: "Building",
    chip: "border-sky-500/30 bg-sky-500/10 text-sky-400",
    dot: "bg-sky-500",
    pulse: true,
  },
  deploying: {
    label: "Deploying",
    chip: "border-indigo-500/30 bg-indigo-500/10 text-indigo-400",
    dot: "bg-indigo-500",
    pulse: true,
  },
  pending: {
    label: "Queued",
    chip: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    dot: "bg-amber-500",
    pulse: true,
  },
  in_flight: {
    label: "Building",
    chip: "border-sky-500/30 bg-sky-500/10 text-sky-400",
    dot: "bg-sky-500",
    pulse: true,
  },
  failed: {
    label: "Error",
    chip: "border-red-500/30 bg-red-500/10 text-red-400",
    dot: "bg-red-500",
  },
  stopped: {
    label: "Stopped",
    chip: "border-border/70 bg-muted/40 text-muted-foreground",
    dot: "bg-muted-foreground/70",
  },
  idle: {
    label: "Idle",
    chip: "border-border/70 bg-muted/40 text-muted-foreground",
    dot: "bg-muted-foreground/70",
  },
  running: {
    label: "Ready",
    chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    dot: "bg-emerald-500",
  },
};

export function ProjectStatusChip({ status }: { status: RowStatus }) {
  const key = status.kind === "in_flight" ? status.status : status.kind;
  const cfg = STATUS_CHIP[key];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        cfg.chip,
      )}
    >
      <span className="relative inline-flex size-1.5 shrink-0">
        {cfg.pulse && (
          <span
            className={cn("absolute inset-0 animate-ping rounded-full opacity-70", cfg.dot)}
            aria-hidden
          />
        )}
        <span className={cn("relative size-1.5 rounded-full", cfg.dot)} aria-hidden />
      </span>
      {cfg.label}
    </span>
  );
}
