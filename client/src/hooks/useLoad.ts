import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Calls `load` when the component mounts and whenever `key` changes, then
 * every `every` ms while `every` is set. The newest `load` is the one called,
 * so it reads current props and state without being a dependency. Nothing
 * runs while `enabled` is false.
 */
export function useLoad(
  load: () => Promise<unknown>,
  { key, every = null, enabled = true }: { key?: unknown; every?: number | null; enabled?: boolean } = {},
) {
  const latest = useRef(load);
  useLayoutEffect(() => {
    latest.current = load;
  });
  useEffect(() => {
    if (!enabled) return;
    const run = () => void latest.current().catch(() => {});
    run();
    if (every == null) return;
    const timer = setInterval(run, every);
    return () => clearInterval(timer);
  }, [key, every, enabled]);
}
