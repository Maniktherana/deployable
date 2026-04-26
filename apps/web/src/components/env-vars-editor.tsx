import { Plus, X } from "lucide-react";
import { type ClipboardEvent, useCallback, useId } from "react";
import type { EnvVarMap } from "#/lib/api";
import { cn } from "#/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export type EnvRow = { id: string; key: string; value: string };

export type EnvVarsEditorProps = {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
  disabled?: boolean;
  className?: string;
  /** Optional id used to scope label associations. */
  idPrefix?: string;
};

let idCounter = 0;
function makeRowId(): string {
  idCounter += 1;
  return `env-${Date.now().toString(36)}-${idCounter}`;
}

export function makeEmptyRow(): EnvRow {
  return { id: makeRowId(), key: "", value: "" };
}

/**
 * Parse a `.env`-style blob into key/value pairs. Handles `KEY=value`,
 * `export KEY=value`, double/single-quoted values, `#` comments, and blank
 * lines. Lines that don't contain an `=` are skipped silently.
 */
export function parseDotenv(input: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const rawLine of input.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip an inline `# comment` only when value isn't quoted
    if (!(value.startsWith('"') || value.startsWith("'"))) {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}

/** Detects whether pasted text looks like a multi-line `.env` blob. */
function looksLikeDotenv(text: string): boolean {
  if (!text.includes("\n") && !text.startsWith("export ")) {
    return false;
  }
  // Must contain at least one KEY=VALUE-looking line
  return /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(text);
}

export function rowsToMap(rows: EnvRow[]): EnvVarMap {
  const out: EnvVarMap = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.value;
  }
  return out;
}

export function mapToRows(map: EnvVarMap | undefined): EnvRow[] {
  if (!map) return [];
  return Object.entries(map).map(([key, value]) => ({ id: makeRowId(), key, value }));
}

export function EnvVarsEditor({
  rows,
  onChange,
  disabled,
  className,
  idPrefix,
}: EnvVarsEditorProps) {
  const fallbackPrefix = useId();
  const prefix = idPrefix ?? fallbackPrefix;

  const addRow = useCallback(() => {
    onChange([...rows, makeEmptyRow()]);
  }, [rows, onChange]);

  const removeRow = useCallback(
    (id: string) => {
      const next = rows.filter((r) => r.id !== id);
      onChange(next.length > 0 ? next : [makeEmptyRow()]);
    },
    [rows, onChange],
  );

  const updateRow = useCallback(
    (id: string, patch: Partial<EnvRow>) => {
      onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [rows, onChange],
  );

  /**
   * Pasting a multi-line `.env` blob into either the key or value input
   * replaces the current row(s) with parsed entries. Single-value pastes fall
   * through to default behavior.
   */
  const handlePaste = useCallback(
    (rowId: string, field: "key" | "value", e: ClipboardEvent<HTMLInputElement>) => {
      const text = e.clipboardData.getData("text");
      if (!looksLikeDotenv(text)) return;
      const parsed = parseDotenv(text);
      if (parsed.length === 0) return;
      e.preventDefault();
      const idx = rows.findIndex((r) => r.id === rowId);
      if (idx === -1) return;
      const current = rows[idx]!;
      const targetIsEmpty = !current.key.trim() && !current.value.trim();
      const newRows: EnvRow[] = parsed.map((p) => ({
        id: makeRowId(),
        key: p.key,
        value: p.value,
      }));
      if (targetIsEmpty) {
        // Replace the (empty) row that received the paste
        onChange([...rows.slice(0, idx), ...newRows, ...rows.slice(idx + 1)]);
      } else if (field === "key") {
        // Pasting into a non-empty key likely means "replace from here"
        onChange([...rows.slice(0, idx), ...newRows, ...rows.slice(idx + 1)]);
      } else {
        // Pasting into a value: keep the current row, append the parsed ones below
        onChange([...rows.slice(0, idx + 1), ...newRows, ...rows.slice(idx + 1)]);
      }
    },
    [rows, onChange],
  );

  const visible = rows.length === 0 ? [makeEmptyRow()] : rows;

  return (
    <div className={cn("space-y-2", className)}>
      <ul className="space-y-2">
        {visible.map((row, i) => (
          <li key={row.id} className="flex items-center gap-2">
            <Input
              aria-label={`Key ${i + 1}`}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              className="flex-1 font-mono text-xs"
              disabled={disabled}
              id={`${prefix}-key-${row.id}`}
              onChange={(e) => updateRow(row.id, { key: e.currentTarget.value })}
              onPaste={(e) => handlePaste(row.id, "key", e)}
              placeholder="KEY"
              spellCheck={false}
              value={row.key}
            />
            <Input
              aria-label={`Value ${i + 1}`}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              className="flex-1 font-mono text-xs"
              disabled={disabled}
              id={`${prefix}-value-${row.id}`}
              onChange={(e) => updateRow(row.id, { value: e.currentTarget.value })}
              onPaste={(e) => handlePaste(row.id, "value", e)}
              placeholder="value"
              spellCheck={false}
              value={row.value}
            />
            <Button
              aria-label={`Remove ${row.key || `row ${i + 1}`}`}
              disabled={disabled}
              onClick={() => removeRow(row.id)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      <Button
        className="w-full"
        disabled={disabled}
        onClick={addRow}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" />
        Add another
      </Button>
      <p className="text-muted-foreground/80 text-xs">
        Tip: paste a <code className="font-mono">.env</code> file to fill multiple rows at once.
      </p>
    </div>
  );
}
