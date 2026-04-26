export function shortId(id: string, head = 10): string {
  if (id.length <= head) {
    return id;
  }
  return `${id.slice(0, head)}…`;
}

/**
 * Truncate long OCI ref for UI (full string still in title/tooltip).
 */
export function shortImageTag(tag: string | undefined, max = 48): string {
  if (!tag) {
    return "";
  }
  if (tag.length <= max) {
    return tag;
  }
  return `${tag.slice(0, max - 1)}…`;
}

export function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const s = (Date.now() - t) / 1000;
  if (s < 10) {
    return "just now";
  }
  if (s < 60) {
    return `${Math.floor(s)}s ago`;
  }
  const m = s / 60;
  if (m < 60) {
    return `${Math.floor(m)}m ago`;
  }
  const h = m / 60;
  if (h < 24) {
    return `${Math.floor(h)}h ago`;
  }
  const d = h / 24;
  if (d < 7) {
    return `${Math.floor(d)}d ago`;
  }
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
