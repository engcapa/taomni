import { startTransition, useCallback, useEffect, useRef } from "react";
import { scheduleAfterEditorPaint } from "../scheduleAfterEditorPaint";

/** Batch display projections after the editor's pending measurement and paint. */
export function useWorkspacePaintQueue() {
  const pending = useRef<(() => void)[]>([]);
  const cancel = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel.current?.();
      cancel.current = null;
      pending.current = [];
    };
  }, []);
  return useCallback((project: () => void) => {
    if (!mounted.current) return;
    pending.current.push(project);
    if (cancel.current) return;
    cancel.current = scheduleAfterEditorPaint(() => {
      cancel.current = null;
      const updates = pending.current;
      pending.current = [];
      startTransition(() => { updates.forEach((update) => update()); });
    });
  }, []);
}
