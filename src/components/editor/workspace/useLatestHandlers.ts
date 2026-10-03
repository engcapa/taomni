import { useRef } from "react";

type AnyFunction = (...args: never[]) => unknown;

/**
 * Stable callback props for memoized workspace subtrees.
 *
 * The workspace shell re-renders on every caret move and LSP result, and its
 * handler props are mostly inline closures. Passing them straight into a
 * `memo` child defeats the memo. This hook returns an object of the same
 * shape whose function values keep one identity for the component's lifetime
 * and always call the handler from the latest render, so the child re-renders
 * only when its data props change and never calls a stale closure.
 *
 * Only use it for event handlers. Render callbacks must stay ordinary props:
 * their output depends on the parent's render and must re-run with it.
 */
export function useLatestHandlers<T extends Record<string, AnyFunction | undefined>>(handlers: T): T {
  const latestRef = useRef(handlers);
  latestRef.current = handlers;
  const proxiesRef = useRef(new Map<string, AnyFunction>());
  const result = {} as Record<string, AnyFunction | undefined>;
  for (const key of Object.keys(handlers)) {
    if (typeof handlers[key] !== "function") {
      result[key] = undefined;
      continue;
    }
    let proxy = proxiesRef.current.get(key);
    if (!proxy) {
      proxy = ((...args: never[]) => {
        const current = latestRef.current[key];
        return typeof current === "function" ? current(...args) : undefined;
      }) as AnyFunction;
      proxiesRef.current.set(key, proxy);
    }
    result[key] = proxy;
  }
  return result as T;
}
