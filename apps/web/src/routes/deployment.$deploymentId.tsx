import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { getDeployment } from "#/lib/api";
import { Skeleton } from "#/components/ui/skeleton";

/**
 * Direct links to /deployment/:id are forwarded to the project with the log sheet open.
 */
export const Route = createFileRoute("/deployment/$deploymentId")({
  component: RedirectToAppLogs,
});

function RedirectToAppLogs() {
  const { deploymentId } = useParams({ strict: false });
  if (!deploymentId) {
    return <p className="text-destructive text-sm">Invalid URL</p>;
  }
  const nav = useNavigate();
  const dQ = useQuery({
    queryKey: ["deployment", deploymentId],
    queryFn: () => getDeployment(deploymentId),
  });

  useLayoutEffect(() => {
    if (dQ.isSuccess) {
      void nav({
        to: "/$projectId",
        params: { projectId: dQ.data.appId },
        search: { log: dQ.data.id },
        replace: true,
      });
    }
  }, [dQ.isSuccess, dQ.data, nav, deploymentId]);

  if (dQ.isError) {
    return <p className="text-destructive text-sm">Deployment not found.</p>;
  }
  return (
    <div className="text-muted-foreground flex items-center justify-center py-20 text-sm">
      <Skeleton className="h-4 w-32" />
    </div>
  );
}
