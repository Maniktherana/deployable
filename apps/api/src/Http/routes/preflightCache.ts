import type { RailpackPreflightInfo } from "../../Services/SourceService.ts";

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 64;

type Entry = {
  readonly value: RailpackPreflightInfo;
  readonly expiresAt: number;
};

const cache = new Map<string, Entry>();

export function getCachedPreflight(key: string): RailpackPreflightInfo | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

export function putCachedPreflight(key: string, value: RailpackPreflightInfo): void {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}
