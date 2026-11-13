import { useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { EXPLORER_RESTORE_EVENT, readExplorerRestoreEnabled, readExplorerTabSnapshot, writeExplorerTabSnapshot } from "./tabRecovery";

/** One owner per app root. Restore once, then subscribe to committed metadata;
 * close writes the new (including empty) snapshot instead of resurrecting tabs. */
export function useExplorerTabRecovery(): void {
  useEffect(() => {
    const initial = useAppStore.getState();
    if (readExplorerRestoreEnabled() && !initial.tabs.some((tab) => tab.type === "file-browser")) {
      const snapshot = readExplorerTabSnapshot();
      const existing = new Set(initial.tabs.map((tab) => tab.id));
      const recovered = snapshot.tabs.filter((tab) => !existing.has(tab.id));
      if (recovered.length) {
        useAppStore.setState({ tabs: [...initial.tabs, ...recovered],
          ...(recovered.some((tab) => tab.id === snapshot.activeTabId)
            ? { activeTabId: snapshot.activeTabId, activeSideTab: "sessions" } : {}) });
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const state = useAppStore.getState();
      try { writeExplorerTabSnapshot(state.tabs, state.activeTabId); }
      catch { /* A full/unavailable WebView storage must not crash navigation. */ }
    };
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.tabs === previous.tabs && state.activeTabId === previous.activeTabId) return;
      if (timer === null) timer = setTimeout(flush, 150);
    });
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener(EXPLORER_RESTORE_EVENT, flush);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener(EXPLORER_RESTORE_EVENT, flush);
      flush();
    };
  }, []);
}
