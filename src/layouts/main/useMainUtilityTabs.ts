import { useCallback, useEffect, useMemo, useRef } from "react";
import { t as tr } from "../../lib/i18n";
import { totalUnread, useLanChatStore } from "../../stores/lanChatStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { MailTabInfo } from "../../types";
import { passwordRefFromOptions } from "./authentication";
import { mailSmtpPasswordRefFromOptions, sessionToMailTabInfo } from "./mailSession";
import { useControlTools } from "./useControlTools";
import { useMainConnectionActions } from "./useMainConnectionActions";
import { useMainLayoutState } from "./useMainLayoutState";
import { useMainSessionActions } from "./useMainSessionActions";
import { useMainTerminalIntegration } from "./useMainTerminalIntegration";
import { useMainWorkspaceOpening } from "./useMainWorkspaceOpening";


export interface UseMainUtilityTabsContext {
  layout: ReturnType<typeof useMainLayoutState>;
  workspaceOpening: ReturnType<typeof useMainWorkspaceOpening>;
  connections: ReturnType<typeof useMainConnectionActions>;
  terminals: ReturnType<typeof useMainTerminalIntegration>;
  sessionActions: ReturnType<typeof useMainSessionActions>;
}

export function useMainUtilityTabs(context: UseMainUtilityTabsContext) {
  const { layout, workspaceOpening, connections, terminals, sessionActions } = context;

  const openPlaceholderTab = useCallback((title: string, message: string) => {
    layout.addTab({
      id: `placeholder-${Date.now()}`,
      type: "placeholder",
      title,
      closable: true,
      message,
    });
  }, [layout.addTab]);

  const openSettingsTab = useCallback(() => {
    const existing = layout.tabsRef.current.find((tab) => tab.type === "settings");
    if (existing) {
      layout.setActiveTab(existing.id);
      return;
    }

    layout.addTab({
      id: "settings",
      type: "settings",
      title: layout.t("tabs.settings"),
      closable: true,
    });
  }, [layout.addTab, layout.setActiveTab]);

  useEffect(() => {
    const onOpenSettingsSection = () => {
      openSettingsTab();
    };
    window.addEventListener("taomni:open-settings-section", onOpenSettingsSection);
    return () => window.removeEventListener("taomni:open-settings-section", onOpenSettingsSection);
  }, [openSettingsTab]);
  useControlTools({
    tabsRef: layout.tabsRef,
    loadSessions: layout.loadSessions,
    openQueuedSession: workspaceOpening.openQueuedSession,
    setEditingSession: layout.setEditingSession,
    setNewSessionGroupPath: layout.setNewSessionGroupPath,
    setNewSessionInitialProto: layout.setNewSessionInitialProto,
    setShowSessionEditor: layout.setShowSessionEditor,
    handleQuickConnect: connections.handleQuickConnect,
    setActiveTab: layout.setActiveTab,
    handleDuplicateTab: terminals.handleDuplicateTab,
    updateTabTitle: layout.updateTabTitle,
    removeTab: layout.removeTab,
    moveTabToIndex: layout.moveTabToIndex,
    openSettingsTab,
    openLocalTab: sessionActions.openLocalTab,
    openFileBrowserTab: sessionActions.openFileBrowserTab,
    executeControlToolRef: layout.executeControlToolRef,
    seenControlToolCallsRef: layout.seenControlToolCallsRef,
  });

  const openLanChatTab = useCallback(() => {
    // If LanChat is currently docked as an edge drawer, undock it; the
    // edgeDock effect below restores and focuses the tab.
    if (useLanChatStore.getState().edgeDock) {
      useLanChatStore.getState().closeEdgeDock();
      return;
    }
    const existing = layout.tabsRef.current.find((tab) => tab.type === "lan-chat");
    if (existing) {
      layout.setActiveTab(existing.id);
      return;
    }
    layout.addTab({
      id: "lan-chat",
      type: "lan-chat",
      title: layout.t("tabs.lanChat"),
      closable: true,
    });
  }, [layout.addTab, layout.setActiveTab]);

  /** MFA authenticator: one tab per window (docs-feature/mfa-authenticator-design.md). */
  const openMfaTab = useCallback(() => {
    const existing = layout.tabsRef.current.find((tab) => tab.type === "mfa");
    if (existing) {
      layout.setActiveTab(existing.id);
      return;
    }
    layout.addTab({
      id: "mfa",
      type: "mfa",
      title: layout.t("tabs.mfa"),
      closable: true,
    });
  }, [layout.addTab, layout.setActiveTab]);

  /** Unified mail across every saved mail account (TASK-16, DEC-12). */
  const openUnifiedMailTab = useCallback(() => {
    const existing = layout.tabsRef.current.find((tab) => tab.type === "mail-unified");
    if (existing) {
      layout.setActiveTab(existing.id);
      return;
    }
    layout.addTab({
      id: "mail-unified",
      type: "mail-unified",
      title: layout.t("tabs.mailUnified"),
      closable: true,
    });
  }, [layout.addTab, layout.setActiveTab]);

  // Saved mail sessions plus every open mail tab (quick-connect accounts are
  // not saved); an open tab's info wins because it carries its credentials.
  const unifiedMailAccounts = useMemo(() => {
    const byId = new Map<string, MailTabInfo>();
    for (const session of layout.sessions) {
      if (session.session_type !== "Mail") continue;
      byId.set(session.id, sessionToMailTabInfo(
        session,
        passwordRefFromOptions(session) ?? undefined,
        mailSmtpPasswordRefFromOptions(session) ?? undefined,
      ));
    }
    for (const tab of layout.tabs) {
      if (tab.type === "mail" && tab.mail) byId.set(tab.mail.sessionId, tab.mail);
    }
    return [...byId.values()];
  }, [layout.sessions, layout.tabs]);

  const openMailAccountById = useCallback((sessionId: string) => {
    const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
    if (session) workspaceOpening.openQueuedSession(session);
  }, [workspaceOpening.openQueuedSession]);

  // Initialize LanChat at app startup (not only when the tab opens) so roster,
  // unread, and desktop notifications work even while the tab is closed.
  useEffect(() => {
    void useLanChatStore.getState().init();
  }, []);

  // Keep the lan-chat tab and the in-app edge drawer mutually exclusive.
  // Docking (null → side) hides the main-window tab; undocking (side → null,
  // via the drawer close button or Esc) restores and focuses it. Chat state
  // survives because the store stays alive regardless of the tab's presence.
  const edgeDock = useLanChatStore((s) => s.edgeDock);
  const prevEdgeDock = useRef(edgeDock);
  useEffect(() => {
    const prev = prevEdgeDock.current;
    prevEdgeDock.current = edgeDock;
    if (prev === null && edgeDock !== null) {
      layout.removeTab("lan-chat");
    } else if (prev !== null && edgeDock === null) {
      if (!layout.tabsRef.current.some((tab) => tab.id === "lan-chat")) {
        layout.addTab({
          id: "lan-chat",
          type: "lan-chat",
          title: tr("tabs.lanChat"),
          closable: true,
        });
      }
      layout.setActiveTab("lan-chat");
    }
  }, [edgeDock, layout.addTab, layout.removeTab, layout.setActiveTab]);

  // Mirror total LanChat unread onto the lan-chat tab's new-output indicator
  // (cleared while that tab is active).
  const lanUnread = useLanChatStore((s) => totalUnread(s.conversations));
  useEffect(() => {
    const hasUnread = lanUnread > 0 && layout.activeTabId !== "lan-chat";
    layout.setTabHasNewOutput("lan-chat", hasUnread);
  }, [lanUnread, layout.activeTabId, layout.setTabHasNewOutput]);
  return {
    openPlaceholderTab,
    openSettingsTab,
    openLanChatTab,
    openUnifiedMailTab,
    openMfaTab,
    unifiedMailAccounts,
    openMailAccountById,
  };
}
