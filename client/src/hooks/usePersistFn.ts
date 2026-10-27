import { useCallback, useLayoutEffect, useRef } from "react";

type noop = (...args: any[]) => any;

/**
 * A callback whose identity never changes but always runs the newest `fn`
 * (useCallback without the dependency list).
 */
export function usePersistFn<T extends noop>(fn: T): T {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Parameters<T>) => latest.current(...args), []) as T;
}
