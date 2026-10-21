import { Bot, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { type ToolWindowRailItem } from "../../components/editor/workspace/panels/ToolWindowRail";
import { useViewportSize } from "../../hooks/useViewportSize";
import { resolveChatDock } from "../../lib/chat/chatDock";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";
import { getAppPlatform } from "../../lib/runtime";
import type { Tab } from "../../types";
import { chatBindingIdForTab } from "./sessionPolicy";
import { useMainLayoutState } from "./useMainLayoutState";
import { useMainTerminalIntegration } from "./useMainTerminalIntegration";
import { useMainWindowLifecycle } from "./useMainWindowLifecycle";
import { useTerminalSplitLayout } from "./useTerminalSplitLayout";


export interface UseMainLayoutChromeContext {
  layout: ReturnType<typeof useMainLayoutState>;
  windowLifecycle: ReturnType<typeof useMainWindowLifecycle>;
  terminals: ReturnType<typeof useMainTerminalIntegration>;
}

export function useMainLayoutChrome(context: UseMainLayoutChromeContext) {
  const { layout, windowLifecycle, terminals } = context;

  const terminalTabs = layout.tabs.filter((t) => t.type === "terminal");
  const sftpTabs = layout.tabs.filter((t) => t.type === "sftp" && t.sftp);
  const settingsTabs = layout.tabs.filter((t) => t.type === "settings");
  const gitTabs = layout.tabs.filter((t) => t.type === "git" && t.git);
  const codeWorkspaceTabs = layout.tabs.filter((t) => t.type === "code-workspace" && t.codeWorkspace);
  const vncTabs = layout.tabs.filter((t) => t.type === "vnc" && t.vnc);
  const rdpTabs = layout.tabs.filter((t) => t.type === "rdp" && t.rdp);
  const fileBrowserTabs = layout.tabs.filter((t) => t.type === "file-browser" && t.fileBrowser);
  const objectStorageTabs = layout.tabs.filter((t) => t.type === "object-storage" && t.objectStorage);
  const dbTabs = layout.tabs.filter((t) => t.type === "database" && t.db);
  const redisTabs = layout.tabs.filter((t) => t.type === "redis" && t.db);
  const hbaseTabs = layout.tabs.filter((t) => t.type === "hbase-shell" && t.hbase);
  const mailTabs = layout.tabs.filter((t) => t.type === "mail" && t.mail);
  const terminalSplitVisible =
    layout.terminalSplitActive && terminalTabs.length > 0 && layout.activeTab?.type === "terminal";
  // ED-PARITY-027 B: a terminal's tool windows (attached SFTP, Chat) move from
  // its floating actions into the collapsed sidebar rail.
  const terminalRailMerged = layout.mergeToolWindowRail && layout.sidebarCollapsed && !!layout.mainRailHost
    && layout.activeTab?.type === "terminal" && !terminalSplitVisible;
  const toggleTerminalSftp = (tab: Tab) => {
    if (layout.sftpDetachedTabs[tab.id] && tab.ssh) {
      windowLifecycle.openDetachedSftp(
        {
          sessionId: `attached-${tab.id}`,
          host: tab.ssh.host,
          port: tab.ssh.port,
          username: tab.ssh.username,
          authMethod: tab.ssh.authMethod,
          authData: tab.ssh.authData,
          networkSettingsJson: JSON.stringify(
            toNetworkSettingsPayload(getSessionNetworkSettings(tab.ssh.optionsJson)),
          ),
          initialPath: layout.terminalCwds[tab.id],
          attachedToTerminal: true,
        },
        `${tab.title} — SFTP`,
      );
    } else {
      terminals.toggleAttachedSidebar(tab.id);
    }
  };
  const terminalRailItems: ToolWindowRailItem[] = [];
  if (terminalRailMerged && layout.activeTab) {
    const railTab = layout.activeTab;
    if (railTab.ssh) {
      terminalRailItems.push({
        id: "sftp",
        label: layout.t("terminal.sftpFloatingButtonLabel"),
        icon: <FolderOpen />,
        active: !!layout.attachedSidebars[railTab.id],
        testId: "attached-sftp-toggle",
        onSelect: () => toggleTerminalSftp(railTab),
      });
    }
    if (!layout.aiFullyDisabled) {
      terminalRailItems.push({
        id: "chat",
        label: layout.t("terminal.chatFloatingButtonLabel"),
        icon: <Bot />,
        active: layout.chatDrawerOpen && layout.activeTabId === railTab.id,
        testId: "tab-chat-toggle",
        onSelect: () => void layout.toggleTabChat(chatBindingIdForTab(railTab) ?? railTab.id),
      });
    }
  }
  const effectiveMultiExecSelectedCount = layout.terminalSplitActive
    ? [...layout.multiExecSelectedTabIds].filter((id) => !layout.terminalSplitInputLockedTabIds.has(id)).length
    : layout.multiExecSelectedTabIds.size;
  const {
    terminalPanesClass,
    splitGridColumnTemplate,
    splitGridRowTemplate,
    splitGridColumns,
    splitPaneWeightsForTabs,
    startLinearSplitResize,
    splitGridColumnWeightsForLayout,
    startGridSplitResize,
    splitGridRowWeightsForLayout,
    splitPanesRef,
  } = useTerminalSplitLayout({
    terminalTabs,
    terminalSplitVisible,
    terminalSplitLayout: layout.terminalSplitLayout,
  });

  // macOS uses the native overlay title bar (traffic lights + native resize),
  // so the custom resize handles are Windows/Linux only.
  const isMac = getAppPlatform() === "macos";
  const chatDockViewport = useViewportSize();
  // After the drawer has been opened once, keep ChatDrawer mounted (hidden)
  // across tab switches so the transcript does not remount and re-animate.
  const [chatDrawerKeepAlive, setChatDrawerKeepAlive] = useState(false);
  useEffect(() => {
    if (layout.chatDrawerOpen) setChatDrawerKeepAlive(true);
  }, [layout.chatDrawerOpen]);
  const chatDrawerSurfaceActive = !layout.aiFullyDisabled && (layout.chatDrawerOpen || chatDrawerKeepAlive);
  const chatDockMode = chatDrawerSurfaceActive
    ? resolveChatDock(layout.chatDrawerPosition, layout.chatDrawerPinned, chatDockViewport.width, chatDockViewport.height)
    : "floating";
  const chatDrawerInline = chatDockMode === "side-inline";
  const chatDrawerTopPinned = chatDockMode === "stacked-inline" && layout.chatDrawerPosition === "top";
  const chatDrawerBottomPinned = chatDockMode === "stacked-inline" && layout.chatDrawerPosition === "bottom";
  const chatDrawerFloating = chatDrawerSurfaceActive && chatDockMode === "floating";
  return {
    isMac,
    terminalSplitVisible,
    chatDrawerTopPinned,
    terminalRailMerged,
    terminalRailItems,
    chatDrawerInline,
    effectiveMultiExecSelectedCount,
    splitPanesRef,
    terminalPanesClass,
    splitGridColumnTemplate,
    splitGridRowTemplate,
    terminalTabs,
    toggleTerminalSftp,
    splitGridColumns,
    splitPaneWeightsForTabs,
    startLinearSplitResize,
    splitGridColumnWeightsForLayout,
    startGridSplitResize,
    splitGridRowWeightsForLayout,
    sftpTabs,
    settingsTabs,
    gitTabs,
    codeWorkspaceTabs,
    vncTabs,
    rdpTabs,
    fileBrowserTabs,
    objectStorageTabs,
    mailTabs,
    dbTabs,
    redisTabs,
    hbaseTabs,
    chatDrawerFloating,
    chatDrawerBottomPinned,
  };
}
