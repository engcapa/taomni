import { startTransition, useEffect, useState, type ReactNode } from "react";

/** Separate the first editor's construction from the workspace activation commit. */
export function EditorMountBoundary({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      startTransition(() => setReady(true));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return ready ? children : <div role="status" aria-label="Loading editor" aria-busy="true" />;
}
