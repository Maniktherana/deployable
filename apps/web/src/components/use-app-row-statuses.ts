import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { type App, type Deployment, type DeploymentStatus, listAppDeployments } from "#/lib/api";
import { isInFlight, rowStatusFor, type RowStatus } from "./project-status-chip";

type AppRowStatusesResult = {
  statuses: RowStatus[];
  /** Latest deployments per row, in the same order as `apps`. */
  deployments: (readonly Deployment[] | undefined)[];
};

/**
 * Per-app deployment polling. While any row's latest deployment is in flight,
 * that row's deployments query refetches every 2s. When a row transitions out
 * of an in-flight status, the apps list is invalidated so `activeDeploymentId`
 * (and therefore the row's chip) updates without a manual refresh.
 *
 * Always calls the same hooks regardless of `apps` length so it's safe to use
 * after early returns in the parent.
 */
export function useAppRowStatuses(apps: readonly App[]): AppRowStatusesResult {
  const q = useQueryClient();

  const queries = useQueries({
    queries: apps.map((app) => ({
      queryKey: ["deployments", app.id] as const,
      queryFn: () => listAppDeployments(app.id),
      staleTime: 5_000,
      refetchInterval: (query: { state: { data?: { items: Deployment[] } } }) =>
        isInFlight(query.state.data?.items?.[0]?.status) ? 2_000 : false,
    })),
  });

  const prev = useRef(new Map<string, DeploymentStatus>());
  useEffect(() => {
    const next = new Map<string, DeploymentStatus>();
    let needsAppsRefetch = false;
    for (const [i, app] of apps.entries()) {
      const latest = queries[i]?.data?.items?.[0];
      if (!latest) continue;
      next.set(app.id, latest.status);
      if (isInFlight(prev.current.get(app.id)) && !isInFlight(latest.status)) {
        needsAppsRefetch = true;
      }
    }
    prev.current = next;
    if (needsAppsRefetch) {
      void q.invalidateQueries({ queryKey: ["apps"] });
    }
  }, [apps, queries, q]);

  const deployments = queries.map((query) => query.data?.items);
  const statuses = apps.map((app, i) => rowStatusFor(app, deployments[i]));
  return { statuses, deployments };
}
