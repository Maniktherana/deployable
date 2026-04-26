import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import { AlertCircle, ArrowDownToLine, CheckCircle2, Download, Loader2, X } from "lucide-react";
import {
  deploymentLogStreamUrl,
  type Deployment,
  type DeploymentLogEvent,
  type DeploymentStatus,
} from "#/lib/api";
import { cn } from "#/lib/utils";
import { shortId } from "#/lib/format";

type Props = {
  deploymentId: string;
  deployment?: Deployment;
  onClose?: () => void;
};

type LogLevel = DeploymentLogEvent["level"];

function lineTone(level: LogLevel): string {
  if (level === "error") return "text-destructive";
  if (level === "warn") return "text-amber-600 dark:text-amber-400";
  return "text-foreground/90";
}

function StatusDot({ status }: { status: DeploymentStatus }) {
  const base = "size-2 shrink-0 rounded-full";
  switch (status) {
    case "running":
      return <span className={cn(base, "bg-emerald-500")} />;
    case "failed":
      return <span className={cn(base, "bg-destructive")} />;
    case "building":
    case "deploying":
      return <span className={cn(base, "animate-pulse bg-sky-500")} />;
    case "stopped":
      return <span className={cn(base, "bg-muted-foreground/50")} />;
    default:
      return <span className={cn(base, "bg-amber-500")} />;
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ToolbarButton({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs",
        "text-muted-foreground hover:bg-accent hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
      onClick={onClick}
      type="button"
      title={title}
    >
      {children}
    </button>
  );
}

export function DeploymentLogViewer({ deploymentId, deployment, onClose }: Props) {
  const [lines, setLines] = useState<DeploymentLogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUp = useRef(false);
  const seen = useRef(new Set<string>());

  const append = useCallback((e: DeploymentLogEvent) => {
    const k = `${e.sequence}-${e.createdAt}`;
    if (seen.current.has(k)) return;
    seen.current.add(k);
    setLoading(false);
    setLines((prev) => {
      if (prev.some((p) => p.sequence === e.sequence)) return prev;
      return [...prev, e].sort((a, b) => a.sequence - b.sequence);
    });
  }, []);

  useEffect(() => {
    seen.current.clear();
    setLines([]);
    setError(null);
    setLoading(true);
  }, [deploymentId]);

  useEffect(() => {
    const url = deploymentLogStreamUrl(deploymentId);
    const source = new EventSource(url, { withCredentials: false });
    setConnected(true);
    setLoading(true);

    source.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent<string>).data) as DeploymentLogEvent;
        append(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid log event payload");
      }
    });
    source.onerror = () => {
      setConnected(false);
      setLoading(false);
    };

    return () => {
      source.close();
      setConnected(false);
    };
  }, [deploymentId, append]);

  const counts = useMemo(() => {
    let warn = 0;
    let err = 0;
    for (const l of lines) {
      if (l.level === "error") err += 1;
      else if (l.level === "warn") warn += 1;
    }
    return { warn, err };
  }, [lines]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const scrolledUp = distFromBottom > 80;
      userScrolledUp.current = scrolledUp;
      setShowScrollBtn(scrolledUp);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant", block: "end" });
    }
  }, [lines.length]);

  const scrollToBottom = useCallback(() => {
    userScrolledUp.current = false;
    setShowScrollBtn(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  const downloadLog = useCallback(() => {
    const text = lines
      .map((l) => `${l.createdAt}\t${l.level.toUpperCase()}\t${l.phase}\t${l.message}`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `deployment-${deploymentId}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }, [lines, deploymentId]);

  return (
    <div className="bg-background flex min-h-0 w-full min-w-0 flex-col overflow-hidden">
      {/* Toolbar / header */}
      <div className="bg-background border-border/60 flex min-w-0 shrink-0 items-center gap-3 border-b px-3 py-2">
        {/* Deployment identity */}
        <div className="flex min-w-0 items-center gap-2">
          {deployment && <StatusDot status={deployment.status} />}
          {connected && lines.length === 0 && loading && (
            <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" aria-hidden />
          )}
          <code className="text-foreground/80 font-mono text-xs" title={deploymentId}>
            {shortId(deploymentId, 14)}
          </code>
          {deployment && (
            <span className="bg-border/80 text-muted-foreground rounded px-1.5 py-px font-mono text-[10px] capitalize">
              {deployment.status}
            </span>
          )}
          {error && (
            <span className="text-destructive ml-1 max-w-[14rem] truncate text-xs" title={error}>
              {error}
            </span>
          )}
        </div>

        {/* Right side controls */}
        <div className="ml-auto flex items-center gap-0.5">
          <span
            className="text-muted-foreground inline-flex items-center gap-1 px-1.5 text-xs"
            title={`${lines.length - counts.err - counts.warn} info`}
          >
            <CheckCircle2 className="size-3 text-emerald-500" aria-hidden />
            <span className="tabular-nums">{lines.length - counts.err - counts.warn}</span>
          </span>
          {counts.err > 0 && (
            <span
              className="text-muted-foreground inline-flex items-center gap-1 px-1.5 text-xs"
              title={`${counts.err} errors`}
            >
              <AlertCircle className="text-destructive size-3" aria-hidden />
              <span className="tabular-nums">{counts.err}</span>
            </span>
          )}
          <span className="bg-border mx-1 h-3.5 w-px" aria-hidden />
          <ToolbarButton onClick={downloadLog} title="Download log">
            <Download className="size-3.5" aria-hidden />
          </ToolbarButton>
          {onClose && (
            <ToolbarButton onClick={onClose} title="Close">
              <X className="size-3.5" aria-hidden />
            </ToolbarButton>
          )}
        </div>
      </div>

      {/* Log body — relative so the floating button can be positioned inside */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="bg-background h-full min-h-0 overflow-y-auto font-mono text-[0.72rem] leading-5"
        >
          <div className="min-w-0">
            {loading && lines.length === 0 && (
              <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                <span>Deployment queued, starting soon…</span>
              </div>
            )}
            {lines.length === 0 && !loading && !connected && !error && (
              <p className="text-muted-foreground px-3 py-2 text-xs">No log lines yet.</p>
            )}
            {lines.map((l) => (
              <div
                key={`${l.sequence}-${l.createdAt}`}
                className={cn(
                  "group flex w-full min-w-0 items-baseline gap-3 px-3 py-0.5",
                  l.level === "error" && "bg-destructive/5",
                  l.level === "warn" && "bg-amber-500/5",
                  "hover:bg-accent/40",
                )}
              >
                <p
                  className={cn(
                    "min-w-0 flex-1 whitespace-pre-wrap break-words",
                    lineTone(l.level),
                  )}
                >
                  {l.message}
                </p>
                <span
                  className="text-muted-foreground/60 shrink-0 select-none tabular-nums"
                  title={l.createdAt}
                >
                  {formatTimestamp(l.createdAt)}
                </span>
              </div>
            ))}
            <div ref={bottomRef} className="h-1" />
          </div>
        </div>

        {/* Floating scroll-to-bottom button */}
        {showScrollBtn && (
          <button
            type="button"
            onClick={scrollToBottom}
            title="Scroll to bottom"
            className={cn(
              "absolute bottom-4 left-1/2 -translate-x-1/2",
              "flex size-8 items-center justify-center rounded-full",
              "bg-foreground/10 text-foreground backdrop-blur-sm",
              "border-border border",
              "hover:bg-foreground/20 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <ArrowDownToLine className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
