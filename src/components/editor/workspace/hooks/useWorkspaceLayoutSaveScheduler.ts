import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { WorkspaceViewStateChanges } from "../workspaceViewStateChanges";

/** Coalesce layout and view changes without publishing editor render state. */
export function useWorkspaceLayoutSaveScheduler(
  workspaceInstanceId: string,
  persist: RefObject<((instanceId?: string) => void) | null>,
  viewStateChanges: WorkspaceViewStateChanges,
) {
  const timer = useRef<number | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const schedule = useCallback(() => {
    cancel();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      persist.current?.(workspaceInstanceId);
    }, 250);
  }, [cancel, persist, workspaceInstanceId]);

  useEffect(() => {
    const unsubscribe = viewStateChanges.subscribe(schedule);
    return () => { unsubscribe(); cancel(); };
  }, [cancel, schedule, viewStateChanges]);

  return { schedule, cancel };
}
