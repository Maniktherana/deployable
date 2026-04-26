import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { type App, deleteApp, type Deployment, listApps, stopApp } from "#/lib/api";
import { ConfirmDialog } from "#/components/confirm-dialog";
import { DeployForm } from "#/components/deploy-form";
import { ProjectRow } from "#/components/project-row";
import { useAppRowStatuses } from "#/components/use-app-row-statuses";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "#/components/ui/dialog";
import { Skeleton } from "#/components/ui/skeleton";
import { toastManager } from "#/components/ui/toast";

export const Route = createFileRoute("/")({
  component: Home,
});

type PendingAction = { kind: "stop" | "delete"; app: App } | null;

function Home() {
  const q = useQueryClient();
  const nav = useNavigate();

  const appsQ = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const items = appsQ.data?.items ?? [];

  const { statuses, deployments } = useAppRowStatuses(items);

  const [newOpen, setNewOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);

  const onDeployed = (d: Deployment) => {
    setNewOpen(false);
    void nav({
      to: "/$projectId",
      params: { projectId: d.appId },
      search: { log: d.id },
    });
  };

  /**
   * Per-app stop/delete: each request is fired independently so a slow
   * action on one project never blocks acting on another. Errors surface
   * via toast rather than inline text. We don't gate the UI on a single
   * shared "isPending" — the confirm dialog closes right away and the
   * row's status reflects the new state once the cache invalidates.
   */
  const stopAppById = (app: App) => {
    void (async () => {
      try {
        const a = await stopApp(app.id);
        q.setQueryData(["app", a.id], a);
        void q.invalidateQueries({ queryKey: ["apps"] });
        void q.invalidateQueries({ queryKey: ["deployments", a.id] });
      } catch (e) {
        toastManager.add({
          type: "error",
          title: `Couldn't stop "${app.name}"`,
          description: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  };

  const deleteAppById = (app: App) => {
    void (async () => {
      try {
        await deleteApp(app.id);
        void q.invalidateQueries({ queryKey: ["apps"] });
      } catch (e) {
        toastManager.add({
          type: "error",
          title: `Couldn't delete "${app.name}"`,
          description: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  };

  if (appsQ.isLoading) {
    return (
      <div className="space-y-6">
        <div className="bg-muted/40 h-7 w-40 rounded-md" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }

  if (appsQ.isError) {
    return (
      <div className="border-destructive/15 bg-destructive/5 text-destructive rounded-lg border p-4 text-sm">
        <p>{appsQ.error instanceof Error ? appsQ.error.message : "Could not load projects"}</p>
        <button
          className="text-foreground/90 mt-3 text-xs underline underline-offset-2"
          onClick={() => void appsQ.refetch()}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-foreground text-2xl tracking-tight sm:text-3xl">Projects</h1>
          <p className="text-muted-foreground/90 mt-0.5 text-sm">
            Each project has its own host and deployment history.
          </p>
        </div>
        {items.length > 0 && (
          <Button
            className="shrink-0 self-start sm:self-auto"
            onClick={() => setNewOpen(true)}
            size="sm"
            type="button"
          >
            <PlusIcon className="size-3.5" />
            Add project
          </Button>
        )}
      </header>

      {items.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed py-20 text-center">
          <p className="text-muted-foreground/90 text-sm">No projects yet</p>
          <Button className="mt-4" onClick={() => setNewOpen(true)} type="button">
            <PlusIcon className="size-3.5" />
            Create your first project
          </Button>
        </div>
      ) : (
        <ul className="border-border/60 bg-card divide-border/50 shadow-xs divide-y overflow-hidden rounded-xl border">
          {items.map((app, i) => (
            <ProjectRow
              key={app.id}
              app={app}
              status={statuses[i] ?? { kind: "idle" }}
              deployments={deployments[i]}
              onStop={(a) => setPending({ kind: "stop", app: a })}
              onDelete={(a) => setPending({ kind: "delete", app: a })}
            />
          ))}
        </ul>
      )}

      <Dialog onOpenChange={setNewOpen} open={newOpen}>
        <DialogPopup className="w-full max-w-lg">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
          </DialogHeader>
          <DialogPanel className="px-6 pb-6">
            <DeployForm onDeployed={onDeployed} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <ConfirmDialog
        open={pending?.kind === "stop"}
        onOpenChange={(o) => {
          if (!o) setPending(null);
        }}
        title="Stop deployment?"
        description={
          pending?.kind === "stop"
            ? `Are you sure you wish to stop the active deployment for "${pending.app.name}"? The site will go offline immediately.`
            : "Are you sure you wish to stop this deployment?"
        }
        confirmLabel="Stop deployment"
        variant="destructive"
        onConfirm={() => {
          if (pending?.kind !== "stop") return;
          stopAppById(pending.app);
        }}
      />

      <ConfirmDialog
        open={pending?.kind === "delete"}
        onOpenChange={(o) => {
          if (!o) setPending(null);
        }}
        title={pending?.kind === "delete" ? `Delete "${pending.app.name}"?` : "Delete project?"}
        description={
          pending?.kind === "delete" && pending.app.activeDeploymentId
            ? "This project has an active deployment. Deleting it will stop the running container and permanently remove all deployment history. This cannot be undone."
            : "All deployment history will be permanently removed. This cannot be undone."
        }
        confirmLabel="Delete project"
        variant="destructive"
        onConfirm={() => {
          if (pending?.kind !== "delete") return;
          deleteAppById(pending.app);
        }}
      />
    </div>
  );
}
