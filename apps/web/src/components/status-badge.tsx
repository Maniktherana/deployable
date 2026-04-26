import type { DeploymentStatus } from "#/lib/api";
import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";

const styles: Record<DeploymentStatus, string> = {
  running:
    "border border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/20 dark:bg-emerald-500/20 dark:text-emerald-200",
  pending:
    "border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/20 dark:text-amber-200",
  building:
    "border border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-500/20 dark:bg-blue-500/20 dark:text-blue-200",
  deploying:
    "border border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/20 dark:text-indigo-200",
  stopped:
    "border border-zinc-200 bg-zinc-100 text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800/40 dark:text-zinc-200",
  failed: "border border-destructive/20 bg-destructive/5 text-destructive",
};

type Props = {
  status: DeploymentStatus;
  className?: string;
};

export function StatusBadge({ status, className }: Props) {
  return (
    <Badge
      variant="outline"
      className={cn("font-mono text-[10px] tracking-wide uppercase", styles[status], className)}
    >
      {status}
    </Badge>
  );
}
