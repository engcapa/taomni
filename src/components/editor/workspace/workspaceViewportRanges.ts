import type { LspRange } from "../../../lib/editor/lsp";

type Ranges = Record<string, LspRange | null>;
type Update = Ranges | ((current: Ranges) => Ranges);

/** View measurements belong to semantic requests, not the workspace render. */
export function createWorkspaceViewportRanges() {
  let ranges: Ranges = { primary: null, secondary: null };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ranges,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update: (update: Update) => {
      const next = typeof update === "function" ? update(ranges) : update;
      if (next === ranges) return;
      ranges = next;
      listeners.forEach((listener) => listener());
    },
  };
}

export type WorkspaceViewportRanges = ReturnType<typeof createWorkspaceViewportRanges>;
