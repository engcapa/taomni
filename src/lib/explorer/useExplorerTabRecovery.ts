import { useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { EXPLORER_RESTORE_EVENT, EXPLORER_RESTORE_KEY, EXPLORER_TABS_KEY, readExplorerRestoreEnabled, readExplorerTabSnapshot, writeExplorerTabSnapshot, type ExplorerRecoveryForeground } from "./tabRecovery";

// Stable renderer-root ownership, not tab-content ownership. WeakSet scopes the
// one-shot startup to this document and also survives StrictMode effect replay.
const restoredDocuments = new WeakSet<Document>();

function rawSnapshot(): string | null {
  try { return localStorage.getItem(EXPLORER_TABS_KEY); } catch { return null; }
}

function rawPreference(): string | null {
  try { return localStorage.getItem(EXPLORER_RESTORE_KEY); } catch { return null; }
}

/** Restore main tabs once without overriding an existing Home/workspace action.
 * Foreground restoration requires an explicit Explorer-owned exit selection. */
export function useExplorerTabRecovery(): void {
  useEffect(() => {
    if (!restoredDocuments.has(document)) {
      restoredDocuments.add(document);
      const initial = useAppStore.getState();
      const snapshot = readExplorerTabSnapshot();
      if (readExplorerRestoreEnabled() && !initial.tabs.some((tab) => tab.type === "file-browser")) {
        const ids = new Set(initial.tabs.map((tab) => tab.id));
        const recovered = snapshot.tabs.filter((tab) => !ids.has(tab.id));
        const canRestoreForeground = initial.activeSideTab === "home"
          && initial.tabs.every((tab) => tab.type === "welcome");
        if (recovered.length) useAppStore.setState({ tabs: [...initial.tabs, ...recovered] });
        if (canRestoreForeground) {
          const foreground = snapshot.foreground === undefined && snapshot.activeTabId
            ? { kind: "main" as const, tabId: snapshot.activeTabId } : snapshot.foreground;
          if (foreground?.kind === "main" && recovered.some((tab) => tab.id === foreground.tabId)) {
            useAppStore.setState({ activeTabId: foreground.tabId, activeSideTab: "sessions" });
          } else if (foreground?.kind === "workspace") {
            const store = useWorkspacePlatformStore.getState();
            const workspace = store.getWorkspace(foreground.workspaceId);
            const tab = workspace?.openTabs.find((item) => item.id === foreground.tabId);
            if (workspace && tab && (tab.kind === "explorer" || tab.protocol?.toUpperCase() === "FILE")) {
              store.setActiveWorkspace(workspace.id);
              store.setActiveWorkspaceTab(workspace.id, tab.id);
              useAppStore.getState().setActiveSideTab("workspaces");
            }
          }
        }
      }
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let observed = rawSnapshot();
    let observedPreference = rawPreference();
    let externallyReplaced = false;
    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      // Reset/import may remove or replace storage while the old renderer is
      // alive. Its unload handler must never recreate the previous case/profile.
      if (externallyReplaced || rawSnapshot() !== observed || rawPreference() !== observedPreference) {
        externallyReplaced = true;
        return;
      }
      const state = useAppStore.getState();
      const activeExplorer = state.tabs.find((tab) => tab.id === state.activeTabId && tab.type === "file-browser");
      const previousId = readExplorerTabSnapshot().activeTabId;
      const recoveryId = activeExplorer?.id ?? (state.tabs.some((tab) => tab.id === previousId && tab.type === "file-browser") ? previousId : null);
      let foreground: ExplorerRecoveryForeground = null;
      if (state.activeSideTab === "workspaces") {
        const workspace = useWorkspacePlatformStore.getState().getWorkspace();
        const tab = workspace?.openTabs.find((item) => item.id === workspace.activeTabId);
        if (workspace && tab && (tab.kind === "explorer" || tab.protocol?.toUpperCase() === "FILE")) {
          foreground = { kind: "workspace", workspaceId: workspace.id, tabId: tab.id };
        }
      } else if ((state.activeSideTab === "sessions" || state.activeSideTab === "tools") && recoveryId) {
        // Terminals use a separate restore owner; keep the last main Explorer as
        // fallback only when the user actually leaves the main Sessions surface.
        foreground = { kind: "main", tabId: recoveryId };
      }
      try {
        writeExplorerTabSnapshot(state.tabs, recoveryId, foreground);
        observed = rawSnapshot();
      } catch { /* Unavailable/full WebView storage cannot break navigation. */ }
    };
    const schedule = () => { if (timer === null) timer = setTimeout(flush, 150); };
    const unsubscribeApp = useAppStore.subscribe((state, previous) => {
      if (state.tabs !== previous.tabs || state.activeTabId !== previous.activeTabId || state.activeSideTab !== previous.activeSideTab) schedule();
    });
    const unsubscribeWorkspace = useWorkspacePlatformStore.subscribe((state, previous) => {
      if (state.workspaces !== previous.workspaces || state.activeWorkspaceId !== previous.activeWorkspaceId) schedule();
    });
    const preferenceChanged = () => {
      // This owner's explicit toggle is not an external profile reset.
      observed = rawSnapshot();
      observedPreference = rawPreference();
      externallyReplaced = false;
      flush();
    };
    // Claim even an empty namespace: removing it later is a detectable reset.
    flush();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener(EXPLORER_RESTORE_EVENT, preferenceChanged);
    return () => {
      unsubscribeApp();
      unsubscribeWorkspace();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener(EXPLORER_RESTORE_EVENT, preferenceChanged);
      flush();
    };
  }, []);
}
