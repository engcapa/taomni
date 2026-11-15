import { useBookmarkWindows } from "./useBookmarkWindows";
import { useNotesWorkspaceNavigation } from "./useNotesWorkspaceNavigation";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { t as tr } from "../../lib/i18n";
import { setActiveQueryTab } from "../../lib/queryRegistry";
import {
  hasServersRouteParam,
  hasServersTabClaimMarker,
  openServersTab,
  releaseServersTabLockSafe,
} from "../../lib/serversTab";
import { setActiveTerminalTab } from "../../lib/terminal/terminalRegistry";
import { useAiStore } from "../../stores/aiStore";
import { useAppStore } from "../../stores/appStore";
import { useServersStore } from "../../stores/serversStore";
import {
  createHandleDetachActiveTab,
  createOpenDetachedDatabase,
  createOpenDetachedGenericWindow,
  createOpenDetachedRdp,
  createOpenDetachedSftp,
  createOpenDetachedTerminal,
  createOpenDetachedVnc,
} from "./detachedWindows";
import { chatBindingIdForTab } from "./sessionPolicy";
import { useDetachedWindowEvents } from "./useDetachedWindowEvents";
import { useMainLayoutState } from "./useMainLayoutState";


export interface UseMainWindowLifecycleContext {
  layout: ReturnType<typeof useMainLayoutState>;
}

export function useMainWindowLifecycle(context: UseMainWindowLifecycleContext) {
  useNotesWorkspaceNavigation();
  const { layout } = context;

  const openDetachedSftp = useCallback(createOpenDetachedSftp({
    setStatusMessage: layout.setStatusMessage,
  }), [layout.setStatusMessage]);

  /**
   * Hand off the credentials of a non-SFTP tab to a new OS window and
   * remove the source tab from this window. The new window opens its own
   * backend session of the same kind. Reattach reverses the move via the
   * `BroadcastChannel('taomni.detach.sync')` subscriber wired below.
   */
  const openDetachedGenericWindow = useCallback(
    createOpenDetachedGenericWindow({
      removeTab: layout.removeTab,
      setStatusMessage: layout.setStatusMessage,
    }),
    [layout.removeTab, layout.setStatusMessage],
  );

  const openDetachedRdp = useCallback(
    createOpenDetachedRdp({
      openDetachedGenericWindow,
    }),
    [openDetachedGenericWindow],
  );

  const openDetachedVnc = useCallback(
    createOpenDetachedVnc({
      openDetachedGenericWindow,
      setStatusMessage: layout.setStatusMessage,
    }),
    [openDetachedGenericWindow, layout.setStatusMessage],
  );

  const openDetachedTerminal = useCallback(
    createOpenDetachedTerminal({
      terminalSessionIds: layout.terminalSessionIds,
      terminalProfileOverrides: layout.terminalProfileOverrides,
      terminalProfilesBySessionId: layout.terminalProfilesBySessionId,
      openDetachedGenericWindow,
    }),
    [openDetachedGenericWindow, layout.terminalProfileOverrides, layout.terminalProfilesBySessionId],
  );

  const openDetachedDatabase = useCallback(
    createOpenDetachedDatabase({
      openDetachedGenericWindow,
    }),
    [openDetachedGenericWindow],
  );

  useBookmarkWindows({ openDetachedTerminal, openDetachedRdp, openDetachedVnc, openDetachedDatabase, openDetachedSftp });

  const handleDetachActiveTab = useCallback(createHandleDetachActiveTab({
    openDetachedTerminal,
    openDetachedRdp,
    openDetachedVnc,
    openDetachedDatabase,
    openDetachedSftp,
  }), [openDetachedDatabase, openDetachedRdp, openDetachedSftp, openDetachedTerminal, openDetachedVnc]);
  const showAttachedSftp = useCallback((tabId: string) => {
    layout.setAttachedSidebars((prev) => ({ ...prev, [tabId]: true }));
  }, [layout.setAttachedSidebars]);
  useDetachedWindowEvents({
    tabsRef: layout.tabsRef,
    setActiveTab: layout.setActiveTab,
    addTab: layout.addTab,
    setStatusMessage: layout.setStatusMessage,
    showAttachedSftp,
  });

  useEffect(() => {
    void layout.loadSessions();
  }, [layout.loadSessions]);

  // Probe the local X server once at startup so the status pill reflects
  // reality (Xorg/XQuartz/VcXsrv/WSLg reachable or not) instead of a guess.
  useEffect(() => {
    void layout.refreshXServer();
  }, [layout.refreshXServer]);

  useEffect(() => {
    if (layout.activeTabId) layout.setTabHasNewOutput(layout.activeTabId, false);
  }, [layout.activeTabId, layout.setTabHasNewOutput]);

  // Track which tab the AI Chat Drawer should consider "active" when the user
  // types `@terminal:last-N` or sends generated SQL back to a query tab.
  // `setActiveTerminalTab` is terminal-only (that registry pulls xterm
  // buffers), but a tab-bound chat drawer can belong to any tab kind that
  // exposes a chat toggle (terminal + rdp + database), so the drawer-sync gets the
  // active tab id for those kinds and survives tab switches.
  useEffect(() => {
    const terminalTabId = layout.activeTab?.type === "terminal" ? layout.activeTabId : null;
    setActiveTerminalTab(terminalTabId);
    setActiveQueryTab(layout.activeTab?.type === "database" ? layout.activeTabId : null);
    const chatBoundTabId = chatBindingIdForTab(layout.activeTab);
    void layout.syncTabChatWithActiveTab(chatBoundTabId);
  }, [layout.activeTab, layout.activeTabId, layout.syncTabChatWithActiveTab]);

  useEffect(() => {
    layout.tabsRef.current = layout.tabs;
  }, [layout.tabs]);

  useLayoutEffect(() => {
    const panel = layout.sidebarPanelRef.current;
    if (!panel) return;

    // The title bar belongs to the content panel. Apply its new position
    // before paint so an immediate tab click cannot straddle two layouts.
    if (layout.sidebarCollapsed) {
      panel.collapse();
    } else {
      panel.resize(layout.lastSidebarSizeRef.current > 0 ? `${layout.lastSidebarSizeRef.current}%` : "260px");
    }
  }, [layout.sidebarCollapsed]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void openServersTab({ title: tr("servers.dialogTitle") });
        return;
      }
      const primary = event.ctrlKey || event.metaKey;
      if (!primary || event.altKey || event.key.toLowerCase() !== "l") return;

      if (event.shiftKey) {
        event.preventDefault();
        const aiOff = useAiStore.getState().config?.fully_disabled === true;
        const current = useAppStore.getState().tabs.find((tab) => tab.id === useAppStore.getState().activeTabId);
        const chatTabId = chatBindingIdForTab(current);
        if (!aiOff && chatTabId) {
          void layout.toggleTabChat(chatTabId);
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [layout.toggleTabChat]);

  // Hydrate server configs + statuses once on mount so the servers panel
  // opens with persisted settings and live run state. Also honor `?servers=main`
  // or `#servers=main` launch routes inside the main window tab bar (both on
  // initial mount and on in-window `#servers=main` hash navigation).
  useEffect(() => {
    void useServersStore.getState().loadAll();
    const openServersIfRouted = () => {
      if (hasServersRouteParam()) {
        void openServersTab({ title: tr("servers.dialogTitle") });
        return true;
      }
      return false;
    };
    if (
      !openServersIfRouted() &&
      hasServersTabClaimMarker() &&
      !useAppStore.getState().tabs.some((tab) => tab.type === "servers")
    ) {
      void releaseServersTabLockSafe();
    }
    const handleHashChange = () => {
      openServersIfRouted();
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const hasServersTab = layout.tabs.some((tab) => tab.type === "servers");
  const hadServersTabRef = useRef(hasServersTab);
  useEffect(() => {
    if (!hasServersTab) {
      if (hadServersTabRef.current) {
        hadServersTabRef.current = false;
        useServersStore.getState().clearDirty();
        void useServersStore.getState().loadAll();
        void releaseServersTabLockSafe();
      }
      return undefined;
    }
    hadServersTabRef.current = true;
    const handleUnload = () => {
      void releaseServersTabLockSafe();
    };
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [hasServersTab]);
  return {
    openDetachedSftp,
    handleDetachActiveTab,
    openDetachedTerminal,
    openDetachedVnc,
    openDetachedRdp,
  };
}
