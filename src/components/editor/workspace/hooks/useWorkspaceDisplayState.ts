import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Avoid queuing an unchanged display projection during an external-store
 * commit. React can otherwise render that no-op transition after the commit.
 * The ref includes pending projections so successive updates keep their order.
 */
export function useWorkspaceDisplayState<T>(initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(initial);
  const latest = useRef(value);
  const update = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const next = typeof action === "function"
      ? (action as (current: T) => T)(latest.current) : action;
    if (Object.is(next, latest.current)) return;
    latest.current = next;
    setValue(() => next);
  }, []);
  return [value, update];
}
