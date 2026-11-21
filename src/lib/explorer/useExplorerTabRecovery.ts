import { useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { EXPLORER_RESTORE_EVENT, EXPLORER_RESTORE_KEY, EXPLORER_TABS_KEY, readExplorerRestoreEnabled, readExplorerTabSnapshot, writeExplorerTabSnapshot } from "./tabRecovery";

const restoredDocuments = new WeakSet<Document>();

function rawSnapshot(): string | null {
  try { return localStorage.getItem(EXPLORER_TABS_KEY); } catch { return null; }
}

function rawPreference(): string | null {
  try { return localStorage.getItem(EXPLORER_RESTORE_KEY); } catch { return null; }
}

function migrateMainTabs(): void {
  const app = useAppStore.getState();
  const legacy = app.tabs.filter((tab) => tab.type === "file-browser" && tab.fileBrowser);
  if (!legacy.length) return;
  const explorer = useExplorerStore.getState();
  const ids = new Set(explorer.tabs.map((tab) => tab.id));
  useExplorerStore.setState({
    tabs: [...explorer.tabs, ...legacy.filter((tab) => !ids.has(tab.id))],
    activeTabId: explorer.activeTabId ?? legacy[0].id,
  });
  const activeLegacy = legacy.some((tab) => tab.id === app.activeTabId);
  useAppStore.setState({ tabs: app.tabs.filter((tab) => tab.type !== "file-browser") });
  if (activeLegacy && (app.activeSideTab === "sessions" || app.activeSideTab === "tools")) app.setActiveSideTab("explorer");
}

export function useExplorerTabRecovery(): void {
  useEffect(() => {
    if (!restoredDocuments.has(document)) {
      restoredDocuments.add(document);
      const initial = useAppStore.getState();
      const explorer = useExplorerStore.getState();
      const snapshot = readExplorerTabSnapshot();
      if (readExplorerRestoreEnabled() && !explorer.tabs.some((tab) => tab.type === "file-browser")) {
        const ids = new Set(explorer.tabs.map((tab) => tab.id));
        const recovered = snapshot.tabs.filter((tab) => !ids.has(tab.id));
        if (recovered.length) useExplorerStore.setState({
          tabs: [...explorer.tabs, ...recovered],
          activeTabId: recovered.some((tab) => tab.id === snapshot.activeTabId) ? snapshot.activeTabId : recovered[0].id,
        });
        const canRestoreForeground = initial.activeSideTab === "home" && initial.tabs.every((tab) => tab.type === "welcome");
        const foreground = snapshot.foreground === undefined && snapshot.activeTabId
          ? { kind: "main" as const, tabId: snapshot.activeTabId } : snapshot.foreground;
        if (canRestoreForeground && foreground?.kind === "main" && recovered.some((tab) => tab.id === foreground.tabId)) {
          useExplorerStore.getState().setActiveTab(foreground.tabId);
          useAppStore.getState().setActiveSideTab("explorer");
        }
      }
      migrateMainTabs();
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let observed = rawSnapshot();
    let observedPreference = rawPreference();
    let externallyReplaced = false;
    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (externallyReplaced || rawSnapshot() !== observed || rawPreference() !== observedPreference) {
        externallyReplaced = true;
        return;
      }
      const explorer = useExplorerStore.getState();
      const app = useAppStore.getState();
      const recoveryId = explorer.tabs.some((tab) => tab.id === explorer.activeTabId) ? explorer.activeTabId : null;
      const foreground = app.activeSideTab === "explorer" && recoveryId ? { kind: "main" as const, tabId: recoveryId } : null;
      try {
        writeExplorerTabSnapshot(explorer.tabs, recoveryId, foreground);
        observed = rawSnapshot();
      } catch { /* Unavailable/full WebView storage cannot break navigation. */ }
    };
    const schedule = () => { if (timer === null) timer = setTimeout(flush, 150); };
    const unsubscribeExplorer = useExplorerStore.subscribe((state, previous) => {
      if (state.tabs !== previous.tabs || state.activeTabId !== previous.activeTabId) schedule();
    });
    const unsubscribeApp = useAppStore.subscribe((state, previous) => {
      if (state.tabs !== previous.tabs) migrateMainTabs();
      if (state.tabs !== previous.tabs || state.activeSideTab !== previous.activeSideTab) schedule();
    });
    const preferenceChanged = () => {
      observed = rawSnapshot();
      observedPreference = rawPreference();
      externallyReplaced = false;
      flush();
    };
    flush();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener(EXPLORER_RESTORE_EVENT, preferenceChanged);
    return () => {
      unsubscribeExplorer();
      unsubscribeApp();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener(EXPLORER_RESTORE_EVENT, preferenceChanged);
      flush();
    };
  }, []);
}
