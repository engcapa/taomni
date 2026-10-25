import type { AppCommand } from "../../components/menubar/commands";
import type { Tab } from "../../types";
import { useServersStore } from "../../stores/serversStore";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { parseQuickConnectInput } from "../../lib/quickConnect";
import { type SessionConfig } from "../../lib/ipc";
import { type TerminalProfile } from "../../lib/terminalProfile";
import type { LocalLaunchOutcome, LocalShellSelection } from "../../types";
import { t as tr } from "../../lib/i18n";
import { type PendingAuth } from "./types";
import { COMMAND_TERMINAL_SESSION_TYPES } from "./sessionPolicy";



export interface HandleQuickConnectContext {
  openLocalTab: (title?: string, sessionId?: string, terminalProfile?: TerminalProfile, localShell?: LocalShellSelection, initialCwd?: string, chatTabId?: string) => Promise<LocalLaunchOutcome>;
  openBrowserSession: (session: SessionConfig) => void;
  openMailTab: (session: SessionConfig, password?: string, smtpPassword?: string) => void;
  openCommandTerminalTab: (session: SessionConfig) => void;
  openVncTab: (session: SessionConfig, password?: string) => void;
  awaitingManualAuthRef: import("react").RefObject<boolean>;
  setPendingAuth: import("react").Dispatch<import("react").SetStateAction<PendingAuth | null>>;
  openSftpTab: (session: SessionConfig, authMethod: string, authData: string | null) => void;
  openRdpTab: (session: SessionConfig, password?: string) => void;
  openSshTab: (session: SessionConfig, authMethod: string, authData: string | null) => void;
  openUnsupportedTab: (session: SessionConfig) => void;
  setStatusMessage: (message: string) => void;
}


export function createHandleQuickConnect(controllerContext: HandleQuickConnectContext): (value: string) => void {
  return (value: string) => {
    try {
      const parsed = parseQuickConnectInput(value);
      const session = parsed.config;
      if (session.session_type === "LocalShell") {
        controllerContext.openLocalTab(session.name);
      } else if (session.session_type === "Browser") {
        controllerContext.openBrowserSession(session);
      } else if (session.session_type === "Mail") {
        controllerContext.openMailTab(session, parsed.authData ?? undefined);
      } else if (COMMAND_TERMINAL_SESSION_TYPES.has(session.session_type)) {
        controllerContext.openCommandTerminalTab(session);
      } else if (
        session.session_type === "SSH"
        || session.session_type === "SFTP"
        || session.session_type === "RDP"
        || session.session_type === "VNC"
      ) {
        if (session.session_type === "VNC" && session.auth_method === "Password") {
          // DEC-VNC-21: like saved sessions, ask in the session only when the
          // server requires a password.
          controllerContext.openVncTab(session);
        } else if (session.auth_method === "Password") {
          controllerContext.awaitingManualAuthRef.current = true;
          controllerContext.setPendingAuth({ kind: "session", session });
        } else {
          const authMethod = typeof session.auth_method === "string" ? session.auth_method : "PrivateKey";
          if (session.session_type === "SFTP") {
            controllerContext.openSftpTab(session, authMethod, parsed.authData);
          } else if (session.session_type === "RDP") {
            controllerContext.openRdpTab(session, parsed.authData ?? undefined);
          } else if (session.session_type === "VNC") {
            controllerContext.openVncTab(session, parsed.authData ?? undefined);
          } else {
            controllerContext.openSshTab(session, authMethod, parsed.authData);
          }
        }
      } else {
        controllerContext.openUnsupportedTab(session);
      }
    } catch (err) {
      controllerContext.setStatusMessage(err instanceof Error ? err.message : String(err));
    }
  };
}



export interface HandleCommandContext {
  handleNewSession: (groupPath?: string | null) => void;
  handleNewSftpSession: () => void;
  openLocalTab: (title?: string, sessionId?: string, terminalProfile?: TerminalProfile, localShell?: LocalShellSelection, initialCwd?: string, chatTabId?: string) => Promise<LocalLaunchOutcome>;
  activeTab: Tab | undefined;
  removeTab: (id: string) => void;
  loadSessions: () => Promise<void>;
  setStatusMessage: (message: string) => void;
  toggleXServer: () => void;
  toggleSidebar: () => void;
  toggleQuickConnectVisible: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleTerminalSplit: () => void;
  toggleMultiExec: () => void;
  requestAppExit: () => void;
  tabsRef: import("react").RefObject<Tab[]>;
  setActiveTab: (id: string) => void;
  addTab: (tab: Tab) => void;
  t: import("../../lib/i18n").TranslateFn;
  openPlaceholderTab: (title: string, message: string) => void;
  openGitRepository: (path?: string | null) => Promise<void>;
  openEmptyCodeWorkspaceTab: () => void;
  openSettingsTab: () => void;
  openLanChatTab: () => void;
  openUnifiedMailTab: () => void;
  openMfaTab: () => void;
  setShowAbout: import("react").Dispatch<import("react").SetStateAction<boolean>>;
}


export function createHandleCommand(controllerContext: HandleCommandContext): (command: AppCommand) => void {
  return (command: AppCommand) => {
    switch (command) {
      case "new-session":
        controllerContext.handleNewSession();
        break;
      case "new-sftp":
        controllerContext.handleNewSftpSession();
        break;
      case "new-terminal":
        controllerContext.openLocalTab();
        break;
      case "close-active":
        if (useAppStore.getState().activeSideTab === "workspaces") {
          const platform = useWorkspacePlatformStore.getState();
          const workspace = platform.getWorkspace();
          const tab = workspace?.openTabs.find((item) => item.id === workspace.activeTabId);
          if (workspace && tab?.closable) platform.closeWorkspaceTab(workspace.id, tab.id);
          break;
        }
        if (controllerContext.activeTab?.closable) controllerContext.removeTab(controllerContext.activeTab.id);
        break;
      case "reload-sessions":
        void controllerContext.loadSessions();
        controllerContext.setStatusMessage(tr("status.sessionsReloaded"));
        break;
      case "toggle-xserver":
        controllerContext.toggleXServer();
        break;
      case "view":
        controllerContext.toggleSidebar();
        break;
      case "toggle-quick-connect":
        controllerContext.toggleQuickConnectVisible();
        break;
      case "servers":
        useServersStore.getState().openDialog(tr("servers.dialogTitle"));
        break;
      case "sessions":
        controllerContext.setSidebarCollapsed(false);
        break;
      case "split":
        controllerContext.toggleTerminalSplit();
        break;
      case "multiexec":
        controllerContext.toggleMultiExec();
        break;
      case "exit":
        controllerContext.requestAppExit();
        break;
      case "tunneling": {
        const existing = controllerContext.tabsRef.current.find((tab) => tab.type === "nettools");
        if (existing) {
          controllerContext.setActiveTab(existing.id);
        } else {
          controllerContext.addTab({
            id: "nettools-tunnels",
            type: "nettools",
            title: controllerContext.t("tunnels.title"),
            closable: true,
          });
        }
        break;
      }
      case "sockscap": {
        const existing = controllerContext.tabsRef.current.find((tab) => tab.type === "sockscap");
        if (existing) {
          controllerContext.setActiveTab(existing.id);
        } else {
          controllerContext.addTab({
            id: "sockscap-main",
            type: "sockscap",
            title: controllerContext.t("sockscap.title"),
            closable: true,
          });
        }
        break;
      }
      case "tools":
        controllerContext.openPlaceholderTab(controllerContext.t("tabs.networkTools"), controllerContext.t("status.commandUnavailable"));
        break;
      case "git":
        void controllerContext.openGitRepository();
        break;
      case "code-workspace":
        controllerContext.openEmptyCodeWorkspaceTab();
        break;
      case "settings":
        controllerContext.openSettingsTab();
        break;
      case "lan-chat":
        controllerContext.openLanChatTab();
        break;
      case "mail-unified":
        controllerContext.openUnifiedMailTab();
        break;
      case "mfa":
        controllerContext.openMfaTab();
        break;
      case "help":
        controllerContext.setShowAbout(true);
        break;
      default:
        controllerContext.setStatusMessage(tr("status.commandUnavailable"));
    }
  };
}
