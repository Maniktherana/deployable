import { lazy, Suspense } from "react";
import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

import "../styles.css";
import { AppHeaderTools } from "#/components/app-header-tools";
import { ToastProvider } from "#/components/ui/toast";
import { cn } from "#/lib/utils";

/**
 * Devtools should never ship in a production bundle. Vite replaces
 * `import.meta.env.DEV` with a literal at build time, so the conditional
 * import + lazy panels get tree-shaken when `vite build` runs.
 */
const Devtools = import.meta.env.DEV
  ? lazy(async () => {
      const [{ TanStackDevtools }, { TanStackRouterDevtoolsPanel }] = await Promise.all([
        import("@tanstack/react-devtools"),
        import("@tanstack/react-router-devtools"),
      ]);
      return {
        default: () => (
          <TanStackDevtools
            config={{ position: "bottom-right" }}
            plugins={[
              {
                name: "TanStack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        ),
      };
    })
  : null;

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <ToastProvider position="bottom-right">
      <div className="min-h-svh flex w-full min-w-0 flex-col bg-background text-foreground antialiased">
        <header
          className={cn(
            "sticky top-0 z-40 w-full shrink-0 border-border/50 border-b",
            "bg-background/90 backdrop-saturate-100 backdrop-blur supports-[backdrop-filter]:backdrop-blur-md",
          )}
        >
          <div
            className={cn(
              "flex h-12 w-full min-w-0 items-center justify-between gap-3 px-4",
              "sm:px-6 lg:px-8",
            )}
          >
            <Link
              to="/"
              className="flex min-w-0 shrink items-center gap-2 font-medium text-foreground/95 tracking-tight"
            >
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-foreground/5 text-[11px] font-semibold text-muted-foreground">
                D
              </span>
              <span className="min-w-0">Deployable</span>
            </Link>
            <AppHeaderTools />
          </div>
        </header>
        <div className="w-full min-h-0 min-w-0 flex-1">
          <div className="w-full px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
            <Outlet />
          </div>
        </div>
        {Devtools ? (
          <Suspense fallback={null}>
            <Devtools />
          </Suspense>
        ) : null}
      </div>
    </ToastProvider>
  );
}
