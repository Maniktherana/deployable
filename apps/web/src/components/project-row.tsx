import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, MoreHorizontal, ScrollText, StopCircle, Trash2 } from "lucide-react";
import type { App, Deployment } from "#/lib/api";
import { ProjectStatusChip, type RowStatus } from "./project-status-chip";
import { Truncate } from "./truncate";
import { Button, buttonVariants } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

type ProjectRowProps = {
  app: App;
  status: RowStatus;
  deployments?: readonly Deployment[];
  onStop: (app: App) => void;
  onDelete: (app: App) => void;
};

export function ProjectRow({ app, status, deployments, onStop, onDelete }: ProjectRowProps) {
  const isLive = status.kind === "ready";
  const activeDep = app.activeDeploymentId
    ? deployments?.find((d) => d.id === app.activeDeploymentId)
    : undefined;
  const visitUrl = activeDep?.status === "running" ? (activeDep.liveUrl ?? null) : null;

  return (
    <li className="hover:bg-muted/30 group transition-colors">
      <div className="flex min-w-0 items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4">
        <Link
          to="/$projectId"
          params={{ projectId: app.id }}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          <span className="bg-foreground/5 text-foreground/80 inline-flex size-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold tracking-tight">
            {app.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="text-foreground truncate text-sm font-medium tracking-tight sm:text-base">
                {app.name}
              </p>
              <ProjectStatusChip status={status} />
            </div>
            <Truncate
              text={app.hostname}
              className="text-muted-foreground/90 mt-0.5 font-mono text-xs tabular-nums sm:text-sm"
            />
          </div>
        </Link>
        <div className="flex shrink-0 items-center gap-1.5">
          {visitUrl && (
            <a
              className={buttonVariants({ size: "sm", variant: "outline" })}
              href={visitUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon className="size-3.5" />
              Visit
            </a>
          )}
          <Menu>
            <MenuTrigger>
              <Button size="icon" type="button" variant="ghost">
                <span className="sr-only">Project actions</span>
                <MoreHorizontal className="text-muted-foreground/80 size-4" />
              </Button>
            </MenuTrigger>
            <MenuPopup align="end" side="bottom" sideOffset={4}>
              <MenuItem render={<Link to="/$projectId" params={{ projectId: app.id }} />}>
                <ScrollText className="size-3.5" />
                Open project
              </MenuItem>
              {isLive && (
                <MenuItem onClick={() => onStop(app)}>
                  <StopCircle className="size-3.5" />
                  Stop deployment
                </MenuItem>
              )}
              <MenuItem onClick={() => onDelete(app)}>
                <Trash2 className="size-3.5" />
                Delete project
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </li>
  );
}
