import { useId } from "react";
import type { BuildConfig } from "#/lib/api";
import { cn } from "#/lib/utils";
import { Input } from "./ui/input";

export type BuildConfigEditorProps = {
  value: BuildConfig;
  onChange: (next: BuildConfig) => void;
  /** Defaults detected by railpack — shown as the placeholder so users
   *  understand what they're overriding. */
  defaults?: BuildConfig;
  disabled?: boolean;
  className?: string;
  /** Compact variant drops the section heading + helper copy. Useful in the
   *  deploy form where the surrounding layout already provides framing. */
  compact?: boolean;
};

/**
 * Two-input editor for railpack `--build-cmd` / `--start-cmd` overrides.
 * Empty strings always mean "use railpack's default", which we surface as
 * the placeholder when we have one detected from preflight.
 */
export function BuildConfigEditor({
  value,
  onChange,
  defaults,
  disabled,
  className,
  compact,
}: BuildConfigEditorProps) {
  const id = useId();
  const buildId = `${id}-build`;
  const startId = `${id}-start`;

  const buildPlaceholder = defaults?.buildCommand?.trim() || "auto-detected by railpack";
  const startPlaceholder = defaults?.startCommand?.trim() || "auto-detected by railpack";

  return (
    <div className={cn("space-y-3", className)}>
      {!compact ? (
        <div>
          <p className="text-foreground text-sm font-medium">Build & start commands</p>
          <p className="text-muted-foreground/80 mt-1 text-xs">
            Override the commands railpack runs. Leave empty to keep the auto-detected default.
          </p>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <label className="text-muted-foreground text-xs font-medium" htmlFor={buildId}>
          Build command
        </label>
        <Input
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          className="font-mono text-xs"
          disabled={disabled}
          id={buildId}
          onChange={(e) => onChange({ ...value, buildCommand: e.currentTarget.value })}
          placeholder={buildPlaceholder}
          spellCheck={false}
          value={value.buildCommand ?? ""}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-muted-foreground text-xs font-medium" htmlFor={startId}>
          Start command
        </label>
        <Input
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          className="font-mono text-xs"
          disabled={disabled}
          id={startId}
          onChange={(e) => onChange({ ...value, startCommand: e.currentTarget.value })}
          placeholder={startPlaceholder}
          spellCheck={false}
          value={value.startCommand ?? ""}
        />
      </div>
    </div>
  );
}
