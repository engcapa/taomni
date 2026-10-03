import type { Layout } from "react-resizable-panels";

const STORAGE_PREFIX = "taomni.resizable-panels.v4.";

function storageKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

export function loadResizableLayout(id: string, panelIds: readonly string[]): Layout | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const layout: Layout = {};
    for (const panelId of panelIds) {
      const value = parsed[panelId];
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      layout[panelId] = value;
    }
    return layout;
  } catch {
    return undefined;
  }
}

export function saveResizableLayout(id: string): (layout: Layout) => void {
  return (layout) => {
    try {
      window.localStorage.setItem(storageKey(id), JSON.stringify(layout));
    } catch {
      /* ignore */
    }
  };
}
