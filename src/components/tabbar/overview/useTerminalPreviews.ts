import { useEffect, useState } from "react";
import { getTerminal, type TerminalRegistryEntry } from "../../../lib/terminal/terminalRegistry";

export const PREVIEW_BATCH_MS = 100;
export const PREVIEW_ACTIVITY_MS = 3000;
const FALLBACK_REFRESH_MS = 1000;
const MAX_PREVIEW_LENGTH = 2400;
const PREVIEW_LINE_COUNT = 14;

export interface TerminalPreview { text: string; outputActive: boolean; }
interface WatchedTerminal {
  entry: TerminalRegistryEntry | null;
  stop?: () => void;
  text: string;
  changedAt: number | null;
}

/** Observes existing buffers only; never creates sessions or owns terminal lifetime. */
export function useTerminalPreviews(tabIds: readonly string[]): ReadonlyMap<string, TerminalPreview> {
  const key = JSON.stringify([...new Set(tabIds)].sort());
  const [previews, setPreviews] = useState<ReadonlyMap<string, TerminalPreview>>(new Map());
  useEffect(() => {
    const ids = JSON.parse(key) as string[];
    const watched = new Map<string, WatchedTerminal>();
    let disposed = false;
    let batch: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (disposed) return;
      const now = Date.now();
      const next = new Map<string, TerminalPreview>();
      for (const [id, value] of watched) {
        if (getTerminal(id) !== value.entry) continue;
        let text = "";
        try { text = (value.entry?.getPreviewText?.(PREVIEW_LINE_COUNT) || value.entry?.getLastLines(PREVIEW_LINE_COUNT) || "").slice(-MAX_PREVIEW_LENGTH); }
        catch { /* A closing terminal is replaced/removed at the next registry tick. */ }
        if (text !== value.text) {
          value.text = text;
          value.changedAt = now;
        }
        next.set(id, { text, outputActive: value.changedAt !== null && now - value.changedAt < PREVIEW_ACTIVITY_MS });
      }
      setPreviews((previous) => previous.size === next.size && [...next].every(([id, value]) => {
        const old = previous.get(id);
        return old?.text === value.text && old.outputActive === value.outputActive;
      }) ? previous : next);
    };
    const queue = () => {
      if (disposed || batch !== undefined) return;
      batch = setTimeout(() => { batch = undefined; publish(); }, PREVIEW_BATCH_MS);
    };
    const reconcile = () => {
      for (const id of ids) {
        const entry = getTerminal(id);
        const previous = watched.get(id);
        if (previous && previous.entry === entry) continue;
        previous?.stop?.();
        let text = "";
        try { text = (entry?.getPreviewText?.(PREVIEW_LINE_COUNT) || entry?.getLastLines(PREVIEW_LINE_COUNT) || "").slice(-MAX_PREVIEW_LENGTH); }
        catch { /* Registry entries can disappear during terminal teardown. */ }
        const value: WatchedTerminal = { entry, text, changedAt: null };
        watched.set(id, value);
        value.stop = entry?.subscribeOutput?.(() => {
          if (!disposed && watched.get(id) === value && getTerminal(id) === value.entry) queue();
        });
      }
      publish();
    };
    reconcile();
    const poll = setInterval(reconcile, FALLBACK_REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(poll);
      if (batch !== undefined) clearTimeout(batch);
      for (const value of watched.values()) value.stop?.();
    };
  }, [key]);
  return previews;
}
