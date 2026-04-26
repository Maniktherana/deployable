import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { getSettings, patchSettings } from "#/lib/api";
import { clampDeploymentConcurrency, PARALLEL_BUILD_CHOICES } from "#/lib/deployment-concurrency";
import { useTheme } from "#/hooks/use-theme";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogFooter,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from "#/components/ui/dialog";
import { Field, FieldLabel } from "#/components/ui/field";
import { cn } from "#/lib/utils";
import { Skeleton } from "#/components/ui/skeleton";

function ThemeButton() {
  const { mode, toggle } = useTheme();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggle}
      className="size-8"
      aria-label={mode === "dark" ? "Use light mode" : "Use dark mode"}
    >
      {mode === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

function ParallelBuildsButton() {
  const q = useQueryClient();
  const s = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    staleTime: 30_000,
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(2);

  const p = useMutation({
    mutationFn: (n: number) => patchSettings({ deploymentConcurrency: n }),
    onSuccess: (d) => {
      q.setQueryData(["settings"], d);
    },
  });

  useEffect(() => {
    if (open && s.isSuccess) {
      setDraft(clampDeploymentConcurrency(s.data.deploymentConcurrency));
    }
  }, [open, s.isSuccess, s.data]);

  if (s.isLoading) {
    return <Skeleton className="h-8 w-32 rounded-md" />;
  }
  if (s.isError || !s.data) {
    return null;
  }

  const current = clampDeploymentConcurrency(s.data.deploymentConcurrency);
  return (
    <>
      <Button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        variant="outline"
        className="h-8 text-muted-foreground/90"
      >
        {current} parallel build{current === 1 ? "" : "s"}
      </Button>

      <Dialog
        onOpenChange={(o) => {
          setOpen(o);
          if (!o && s.isSuccess) {
            setDraft(clampDeploymentConcurrency(s.data.deploymentConcurrency));
          }
        }}
        open={open}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Parallel builds</DialogTitle>
            <DialogDescription>
              Set how many deployments may run in parallel. Values from{" "}
              {String(PARALLEL_BUILD_CHOICES[0])} to{" "}
              {String(PARALLEL_BUILD_CHOICES[PARALLEL_BUILD_CHOICES.length - 1]!)}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Field>
              <FieldLabel>Build workers</FieldLabel>
              <select
                className={cn(
                  "flex h-9 w-full max-w-xs cursor-pointer appearance-none rounded-lg border border-input",
                  "bg-background px-3 pr-8 text-foreground text-sm",
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                onChange={(e) => {
                  setDraft(clampDeploymentConcurrency(Number(e.currentTarget.value) || 1));
                }}
                value={draft}
                aria-label="Build workers"
              >
                {PARALLEL_BUILD_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
          </DialogPanel>
          <DialogFooter>
            <Button
              onClick={() => {
                setOpen(false);
                if (s.isSuccess) {
                  setDraft(clampDeploymentConcurrency(s.data.deploymentConcurrency));
                }
              }}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={p.isPending}
              onClick={() => {
                p.mutate(draft, {
                  onSuccess: () => {
                    setOpen(false);
                  },
                });
              }}
              type="button"
            >
              {p.isPending ? "…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function AppHeaderTools() {
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <ParallelBuildsButton />
      <ThemeButton />
    </div>
  );
}
