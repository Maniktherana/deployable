import { useCallback, useSyncExternalStore } from "react";

const KEY = "deployable-theme";
type M = "light" | "dark";

function getSnapshot(): M {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function subscribe(fn: () => void) {
  const o = new MutationObserver(fn);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => o.disconnect();
}

export function useTheme() {
  const mode = useSyncExternalStore(subscribe, getSnapshot, () => "light" as M);

  const setMode = useCallback((m: M) => {
    localStorage.setItem(KEY, m);
    document.documentElement.classList.toggle("dark", m === "dark");
  }, []);

  const toggle = useCallback(() => {
    setMode(getSnapshot() === "dark" ? "light" : "dark");
  }, [setMode]);

  return { mode, setMode, toggle };
}
