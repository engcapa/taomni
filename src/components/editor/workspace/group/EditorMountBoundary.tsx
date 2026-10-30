import { startTransition, useEffect, useState, type ReactNode } from "react";
import { scheduleAfterEditorPaint } from "../scheduleAfterEditorPaint";

/** Separate the first editor's construction from the workspace activation commit. */
export function EditorMountBoundary({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    return scheduleAfterEditorPaint(() => {
      startTransition(() => setReady(true));
    });
  }, []);
  return ready ? children : <div role="status" aria-label="Loading editor" aria-busy="true" />;
}
