import { useEffect, useRef, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { MenuBar } from "../components/menubar/MenuBar";
import { Ribbon, type RibbonCommand } from "../components/menubar/Ribbon";
import { QuickConnect } from "../components/quickconnect/QuickConnect";
import { Sidebar } from "../components/sidebar/Sidebar";
import { TabBar } from "../components/tabbar/TabBar";
import { StatusBar } from "../components/statusbar/StatusBar";
import { TerminalPanel } from "../components/terminal/TerminalPanel";
import { SessionEditor } from "../components/session/SessionEditor";
import { AuthPrompt } from "../components/session/AuthPrompt";
import { SettingsPanel } from "../components/settings/SettingsPanel";
import { useAppStore } from "../stores/appStore";
import { useSessionStore } from "../stores/sessionStore";
import { WelcomePanel } from "../components/WelcomePanel";
import { parseQuickConnectInput } from "../lib/quickConnect";
import { exitApp, type SessionConfig } from "../lib/ipc";
import { getSessionTerminalProfile, type TerminalProfile } from "../lib/terminalProfile";
import type { LocalShellSelection } from "../types";

interface PendingAuth {
  session: SessionConfig;
}

export function MainLayout() {
  const {
    tabs,
    activeTabId,
    sidebarCollapsed,
    xServerEnabled,
    addTab,
    removeTab,
    setActiveTab,
    toggleSidebar,
    setSidebarCollapsed,
    toggleXServer,
    setStatusMessage,
  } = useAppStore();
  const { loadSessions, markConnected } = useSessionStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const tabsRef = useRef(tabs);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const lastSidebarSizeRef = useRef(22);
  const [showSessionEditor, setShowSessionEditor] = useState(false);
  const [editingSession, setEditingSession] = useState<SessionConfig | undefined>();
  const [newSessionGroupPath, setNewSessionGroupPath] = useState<string | null>(null);
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;

    const frame = requestAnimationFrame(() => {
      if (sidebarCollapsed) {
        panel.collapse();
      } else {
        panel.resize(lastSidebarSizeRef.current);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [sidebarCollapsed]);

  const confirmExitWithOpenTabs = useCallback(() => {
    const currentTabs = tabsRef.current;
    const terminalCount = currentTabs.filter((tab) => tab.type === "terminal" && tab.closable).length;
    const tabCount = currentTabs.filter((tab) => tab.closable).length;
    if (tabCount === 0) return true;

    return window.confirm(
      `There ${tabCount === 1 ? "is" : "are"} ${tabCount} open tab${tabCount === 1 ? "" : "s"}${terminalCount > 0 ? `, including ${terminalCount} terminal session${terminalCount === 1 ? "" : "s"}` : ""}. Exit NewMob and close them?`,
    );
  }, []);

  const requestAppExit = useCallback(() => {
    if (confirmExitWithOpenTabs()) {
      void exitApp();
    }
  }, [confirmExitWithOpenTabs]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void appWindow.onCloseRequested(async (event) => {
      if (!confirmExitWithOpenTabs()) {
        event.preventDefault();
        return;
      }
      await exitApp().catch(() => {});
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [confirmExitWithOpenTabs]);

  const handleNewSession = useCallback((groupPath: string | null = null) => {
    setEditingSession(undefined);
    setNewSessionGroupPath(groupPath);
    setShowSessionEditor(true);
  }, []);

  const openLocalTab = useCallback((
    title = "Local terminal",
    sessionId?: string,
    terminalProfile?: TerminalProfile,
    localShell?: LocalShellSelection,
  ) => {
    const id = `local-${Date.now()}`;
    addTab({
      id,
      type: "terminal",
      title,
      sessionId,
      localShell,
      terminalProfile,
      closable: true,
    });
    if (sessionId) void markConnected(sessionId);
  }, [addTab, markConnected]);

  const handleEditSession = useCallback((session: SessionConfig) => {
    setEditingSession(session);
    setNewSessionGroupPath(null);
    setShowSessionEditor(true);
  }, []);

  const handleConnectSession = useCallback((session: SessionConfig) => {
    if (session.session_type === "SSH") {
      const authMethod = typeof session.auth_method === "string"
        ? session.auth_method
        : "PrivateKey";

      if (authMethod === "Password") {
        setPendingAuth({ session });
      } else {
        const authData = typeof session.auth_method === "object" && "PrivateKey" in session.auth_method
          ? session.auth_method.PrivateKey.key_path
          : null;
        openSshTab(session, authMethod, authData);
      }
    } else if (session.session_type === "LocalShell") {
      openLocalTab(session.name || "Local terminal", session.id, getSessionTerminalProfile(session.options_json));
    } else {
      openUnsupportedTab(session);
      void markConnected(session.id);
    }
  }, [markConnected, openLocalTab]);

  const openSshTab = useCallback((session: SessionConfig, authMethod: string, authData: string | null) => {
    const id = `ssh-${session.id}-${Date.now()}`;
    addTab({
      id,
      type: "terminal",
      title: session.name || `${session.username}@${session.host}`,
      sessionId: session.id,
      closable: true,
      ssh: {
        host: session.host,
        port: session.port,
        username: session.username ?? "root",
        authMethod,
        authData,
        optionsJson: session.options_json,
      },
      terminalProfile: getSessionTerminalProfile(session.options_json),
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openUnsupportedTab = useCallback((session: SessionConfig) => {
    const id = `${session.session_type.toLowerCase()}-${session.id}-${Date.now()}`;
    const kind = ["SFTP", "RDP", "VNC"].includes(session.session_type)
      ? session.session_type.toLowerCase()
      : "placeholder";
    addTab({
      id,
      type: kind as "sftp" | "rdp" | "vnc" | "placeholder",
      title: session.name || session.host || session.session_type,
      sessionId: session.id,
      closable: true,
      message: `${session.session_type} connection UI is present, but its backend is outside Phase 1-2. Session data is saved and can be edited from the sidebar.`,
    });
  }, [addTab]);

  const handleAuthSubmit = useCallback((password: string) => {
    if (!pendingAuth) return;
    openSshTab(pendingAuth.session, "Password", password);
    setPendingAuth(null);
  }, [pendingAuth, openSshTab]);

  const handleQuickConnect = useCallback((value: string) => {
    try {
      const parsed = parseQuickConnectInput(value);
      const session = parsed.config;
      if (session.session_type === "LocalShell") {
        openLocalTab(session.name);
      } else if (session.session_type === "SSH") {
        if (session.auth_method === "Password") {
          setPendingAuth({ session });
        } else {
          const authMethod = typeof session.auth_method === "string" ? session.auth_method : "PrivateKey";
          openSshTab(session, authMethod, parsed.authData);
        }
      } else {
        openUnsupportedTab(session);
      }
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  }, [openLocalTab, openSshTab, openUnsupportedTab, setStatusMessage]);

  const openPlaceholderTab = useCallback((title: string, message: string) => {
    addTab({
      id: `placeholder-${Date.now()}`,
      type: "placeholder",
      title,
      closable: true,
      message,
    });
  }, [addTab]);

  const openSettingsTab = useCallback(() => {
    const existing = tabsRef.current.find((tab) => tab.type === "settings");
    if (existing) {
      setActiveTab(existing.id);
      return;
    }

    addTab({
      id: "settings",
      type: "settings",
      title: "Settings",
      closable: true,
    });
  }, [addTab, setActiveTab]);

  const handleCommand = useCallback((command: RibbonCommand | "close-active" | "reload-sessions") => {
    switch (command) {
      case "new-session":
        handleNewSession();
        break;
      case "new-terminal":
        openLocalTab();
        break;
      case "close-active":
        if (activeTab?.closable) removeTab(activeTab.id);
        break;
      case "reload-sessions":
        void loadSessions();
        setStatusMessage("Sessions reloaded");
        break;
      case "toggle-xserver":
        toggleXServer();
        break;
      case "view":
        toggleSidebar();
        break;
      case "servers":
      case "sessions":
        setSidebarCollapsed(false);
        break;
      case "split":
      case "multiexec":
        setStatusMessage(`${command === "split" ? "Split view" : "MultiExec"} is not active in this phase`);
        break;
      case "exit":
        requestAppExit();
        break;
      case "tools":
      case "tunneling":
        openPlaceholderTab("Network tools", "Network tools and tunneling will be implemented after the terminal/session MVP.");
        break;
      case "packages":
        openPlaceholderTab("Packages", "Package management is not part of Phase 1-2.");
        break;
      case "settings":
        openSettingsTab();
        break;
      case "games":
      case "macros":
        openPlaceholderTab(command === "games" ? "Games" : "Macros", "This module is intentionally inactive in the MVP.");
        break;
      case "help":
        setActiveTab("welcome");
        break;
      default:
        setStatusMessage("Command is not available in this phase");
    }
  }, [
    activeTab,
    handleNewSession,
    loadSessions,
    openLocalTab,
    openPlaceholderTab,
    openSettingsTab,
    removeTab,
    requestAppExit,
    setActiveTab,
    setStatusMessage,
    setSidebarCollapsed,
    toggleSidebar,
    toggleXServer,
  ]);

  const terminalTabs = tabs.filter((t) => t.type === "terminal");

  return (
    <div
      className="w-full h-full flex flex-col"
      style={{ background: "var(--moba-chrome-bg)" }}
    >
      <MenuBar activeTabClosable={!!activeTab?.closable} onCommand={handleCommand} />
      <Ribbon xServerEnabled={xServerEnabled} onCommand={handleCommand} />
      <QuickConnect
        onConnectInput={handleQuickConnect}
        onConnectSession={handleConnectSession}
        onHome={() => setActiveTab("welcome")}
      />

      <div className="flex-1 flex min-h-0">
        <PanelGroup direction="horizontal" autoSaveId="main-layout">
          <Panel
            ref={sidebarPanelRef}
            defaultSize={22}
            minSize={15}
            maxSize={40}
            collapsible
            collapsedSize={2}
            onCollapse={() => setSidebarCollapsed(true)}
            onExpand={() => setSidebarCollapsed(false)}
            onResize={(size) => {
              if (size > 2) {
                lastSidebarSizeRef.current = size;
              }
            }}
          >
            <div className="h-full overflow-hidden">
              <Sidebar
                compact={sidebarCollapsed}
                onNewSession={handleNewSession}
                onEditSession={handleEditSession}
                onConnectSession={handleConnectSession}
              />
            </div>
          </Panel>

          <PanelResizeHandle className="w-[3px] bg-[var(--moba-divider)] hover:bg-[var(--moba-accent)] transition-colors cursor-col-resize" />

          <Panel>
            <div className="h-full flex flex-col min-w-0">
              <TabBar />
              <div className="flex-1 min-h-0 overflow-hidden relative">
                {/* Welcome panel */}
                {(activeTab?.type === "welcome" || !activeTab) && (
                  <WelcomePanel
                    onStartLocalTerminal={(localShell) => openLocalTab(localShell?.name ?? "Local terminal", undefined, undefined, localShell)}
                    onNewSession={handleNewSession}
                  />
                )}

                {/* All terminal tabs stay mounted, hidden via display */}
                {terminalTabs.map((tab) => (
                  <div
                    key={tab.id}
                    className="absolute inset-0"
                    style={{ display: activeTabId === tab.id ? "block" : "none" }}
                  >
                    <TerminalPanel
                      tabId={tab.id}
                      tabTitle={tab.title}
                      ssh={tab.ssh}
                      localShell={tab.localShell}
                      terminalProfile={tab.terminalProfile}
                      visible={activeTabId === tab.id}
                    />
                  </div>
                ))}

                {activeTab?.type === "settings" && <SettingsPanel />}

                {/* Non-terminal, non-welcome, non-settings tabs */}
                {activeTab && activeTab.type !== "welcome" && activeTab.type !== "terminal" && activeTab.type !== "settings" && (
                  <UnavailablePanel title={activeTab.title} message={activeTab.message} />
                )}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <StatusBar />

      {showSessionEditor && (
        <SessionEditor
          session={editingSession}
          defaultGroupPath={newSessionGroupPath}
          onClose={() => {
            setShowSessionEditor(false);
            setEditingSession(undefined);
            setNewSessionGroupPath(null);
          }}
        />
      )}

      {pendingAuth && (
        <AuthPrompt
          host={pendingAuth.session.host}
          username={pendingAuth.session.username ?? "root"}
          onSubmit={handleAuthSubmit}
          onCancel={() => setPendingAuth(null)}
        />
      )}
    </div>
  );
}

function UnavailablePanel({ title, message }: { title: string; message?: string }) {
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm p-6"
      style={{ background: "var(--moba-term-bg)", color: "var(--moba-term-text)" }}
    >
      <div className="max-w-md text-center">
        <div className="text-lg font-semibold mb-2">{title}</div>
        <div className="text-[12px] text-slate-300">
          {message ?? "This module is not active in the current MVP."}
        </div>
      </div>
    </div>
  );
}
