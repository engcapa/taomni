import {
  Download,
  FileText,
  FolderOpen,
  HelpCircle,
  Menu,
  MessageSquare,
  Inbox,
  Monitor,
  Filter,
  Network,
  KeyRound,
  PanelLeft,
  PanelRight,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  Settings,
  Shield,
  SplitSquareVertical,
  Terminal as TerminalIcon,
  Upload,
  Users,
  Wrench,
  X,
  GitBranch,
  Braces,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { useEffect, useRef, useState } from "react";
import { TabBar } from "./TabBar";
import { OpenTabsMenu } from "./OpenTabsMenu";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { WindowControls } from "../window/WindowControls";
import { WindowDragHandle } from "../window/WindowDragHandle";
import { startWindowDrag } from "../../lib/windowDrag";
import { PlatformToolbarActions } from "./PlatformToolbarActions";
import { WorkspaceTabStrip } from "../workspace/WorkspaceTabStrip";
import { WorkspaceTabsFilter } from "../workspace/WorkspaceTabsFilter";
import { useAppStore } from "../../stores/appStore";
import { useSessionImportExport } from "../menubar/useSessionImportExport";
import type { AppCommand } from "../menubar/commands";
import { getAppPlatform } from "../../lib/runtime";
import { useUpdateStore } from "../../stores/updateStore";
import { useT } from "../../lib/i18n";
import type { LocalShellSelection } from "../../types";
import type { SessionConfig } from "../../lib/ipc";
import type { WorkspaceCommandMenuItem, WorkspaceCommandRegistration } from "../editor/workspace/workspaceCommands";
import type { ActionResult } from "../editor/workspace/workspaceActionRegistry";

const IS_MAC = getAppPlatform() === "macos";
// Width reserved on the left for the native macOS traffic-light controls when
// the overlay title bar is active. Windows/Linux render their own controls on
// the right instead, so no inset is needed there.
const MAC_TRAFFIC_LIGHT_INSET = 76;

interface ControlBarProps {
  activeTabClosable: boolean;
  /** macOS has a native global menu, so the in-bar app-menu button is hidden. */
  nativeMenu: boolean;
  xServerEnabled: boolean;
  quickConnectVisible: boolean;
  workspaceCommands?: WorkspaceCommandMenuItem[];
  getWorkspaceCommands?: () => WorkspaceCommandRegistration | null;
  onCommand: (command: AppCommand) => void;
  onWorkspaceCommand?: (commandId: string) => void | Promise<ActionResult>;
  onToggleSidebar: () => void;
  onStartLocalTerminal: (localShell?: LocalShellSelection) => void;
  onConnectSession: (session: SessionConfig) => void;
  onOpenSessionEditor: () => void;
  onDuplicateTab?: (id: string) => void;
  onDetachActiveTab?: () => void;
  onCloseWindow?: () => void;
  /** Left sidebar collapsed state, for the `◧` toggle's aria-pressed. */
  leftSidebarCollapsed?: boolean;
  /** Opens the `Ctrl+K` global command palette. */
  onOpenGlobalSearch?: () => void;
  /** Receives the DOM node that hosts the active tab's contextual actions. */
  slotRef: (el: HTMLDivElement | null) => void;
}
export function ControlBar({
  activeTabClosable,
  nativeMenu,
  xServerEnabled,
  quickConnectVisible,
  workspaceCommands = [],
  getWorkspaceCommands,
  onCommand,
  onWorkspaceCommand,
  onToggleSidebar,
  onStartLocalTerminal,
  onConnectSession,
  onOpenSessionEditor,
  onDuplicateTab,
  onDetachActiveTab,
  onCloseWindow,
  leftSidebarCollapsed = false,
  onOpenGlobalSearch,
  slotRef,
}: ControlBarProps) {
  const ctx = useContextMenu();
  const menuHost = useMainRailHostStore((s) => s.menuHost);
  const activeSideTab = useAppStore((state) => state.activeSideTab);
  const t = useT();
  const {
    hasSessions,
    importJson,
    importMoba,
    importCsv,
    downloadCsvTemplate,
    importOpenSsh,
    exportJson,
    exportMoba,
    exportCsv,
    exportHtml,
    previewNode,
  } = useSessionImportExport();

  const openMainMenu = (event: React.MouseEvent) => {
    // Opening a menu samples current ownership without subscribing the entire
    // window to every editor selection, mount and command-state publication.
    const commands = getWorkspaceCommands ? getWorkspaceCommands()?.items ?? [] : workspaceCommands;
    const importExportItems: MenuItem[] = [
      {
        label: t("menu.importSessions"),
        testId: "menu-import-sessions",
        icon: <Upload className="w-3 h-3" />,
        children: [
          { label: t("menu.importTaomni"), testId: "import-json", icon: <Upload className="w-3 h-3" />, onClick: importJson },
          { label: t("menu.importMobaXterm"), testId: "import-mobaxterm", icon: <Upload className="w-3 h-3" />, onClick: importMoba },
          { label: t("menu.importCsv"), testId: "import-csv", icon: <FileText className="w-3 h-3" />, onClick: importCsv },
          { label: t("menu.downloadCsvTemplate"), testId: "download-csv-template", icon: <FileText className="w-3 h-3" />, onClick: downloadCsvTemplate },
          { label: t("menu.importOpenSsh"), testId: "import-openssh", icon: <TerminalIcon className="w-3 h-3" />, onClick: importOpenSsh },
        ],
        onClick: () => {},
      },
      {
        label: t("menu.exportSessions"),
        testId: "menu-export-sessions",
        icon: <Download className="w-3 h-3" />,
        disabled: !hasSessions,
        children: [
          { label: t("menu.exportTaomni"), testId: "export-json", icon: <Download className="w-3 h-3" />, onClick: exportJson },
          { label: t("menu.exportMobaXterm"), testId: "export-mobaxterm", icon: <Download className="w-3 h-3" />, onClick: exportMoba },
          { label: t("menu.exportCsv"), testId: "export-csv", icon: <FileText className="w-3 h-3" />, onClick: exportCsv },
          { label: t("menu.exportHtml"), testId: "export-html", icon: <FileText className="w-3 h-3" />, onClick: exportHtml },
        ],
        onClick: () => {},
      },
    ];
    ctx.show(event, [
      { label: t("menu.newLocalTerminal"), testId: "context-menu-item-new-local-terminal", icon: <TerminalIcon className="w-3 h-3" />, onClick: () => onCommand("new-terminal") },
      { label: t("menu.newRemoteSession"), testId: "context-menu-item-new-remote-session", icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
      { label: t("ribbon.newSftp"), testId: "context-menu-item-new-sftp", icon: <FolderOpen className="w-3 h-3" />, onClick: () => onCommand("new-sftp") },
      { label: t("menu.closeActiveTab"), testId: "context-menu-item-close-active-tab", icon: <X className="w-3 h-3" />, onClick: () => onCommand("close-active"), disabled: !activeTabClosable },
      { label: "", separator: true, onClick: () => {} },
      {
        label: t("menu.sessions"),
        testId: "context-menu-item-sessions",
        icon: <FolderOpen className="w-3 h-3" />,
        children: [
          { label: t("menu.showSessions"), testId: "context-menu-item-show-sessions", icon: <FolderOpen className="w-3 h-3" />, onClick: () => onCommand("sessions") },
          { label: t("menu.newSession"), testId: "context-menu-item-new-session", icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
          { label: t("menu.reloadSessions"), testId: "context-menu-item-reload-sessions", icon: <RefreshCw className="w-3 h-3" />, onClick: () => onCommand("reload-sessions") },
          { label: "", separator: true, onClick: () => {} },
          ...importExportItems,
        ],
        onClick: () => {},
      },
      {
        label: t("menu.view"),
        testId: "context-menu-item-view",
        icon: <PanelLeft className="w-3 h-3" />,
        children: [
          { label: t("sidebar.headerTitle"), testId: "context-menu-item-toggle-sidebar", icon: <PanelLeft className="w-3 h-3" />, onClick: onToggleSidebar },
          { label: t("menu.quickConnectToolbar"), testId: "context-menu-item-toggle-quick-connect", icon: <Search className="w-3 h-3" />, checked: quickConnectVisible, onClick: () => onCommand("toggle-quick-connect") },
          { label: t("menu.splitTerminal"), testId: "context-menu-item-split-terminal", icon: <SplitSquareVertical className="w-3 h-3" />, onClick: () => onCommand("split") },
          { label: t("ribbon.multiExec"), testId: "context-menu-item-multiexec", icon: <Users className="w-3 h-3" />, onClick: () => onCommand("multiexec") },
        ],
        onClick: () => {},
      },
      {
        label: t("menu.tools"),
        testId: "context-menu-item-tools",
        icon: <Wrench className="w-3 h-3" />,
        children: [
          { label: t("servers.dialogTitle"), testId: "context-menu-item-servers", icon: <Server className="w-3 h-3" />, onClick: () => onCommand("servers") },
          { label: t("menu.tunneling"), testId: "context-menu-item-tunneling", icon: <Network className="w-3 h-3" />, onClick: () => onCommand("tunneling") },
          { label: t("menu.sockscap"), testId: "context-menu-item-sockscap", icon: <Shield className="w-3 h-3" />, onClick: () => onCommand("sockscap") },
          { label: t("menu.gitRepository"), testId: "context-menu-item-git-repository", icon: <GitBranch className="w-3 h-3" />, onClick: () => onCommand("git") },
          { label: t("menu.codeWorkspace"), testId: "context-menu-item-code-workspace", icon: <FileText className="w-3 h-3" />, onClick: () => onCommand("code-workspace") },
          ...(commands.length > 0 ? [{
            label: t("menu.codeWorkspaceActions"),
            testId: "context-menu-workspace-actions",
            icon: <Braces className="w-3 h-3" />,
            children: commands.map((command): MenuItem => ({
              label: command.keybinding ? `${command.title}  ${command.keybinding}` : command.title,
              testId: `context-menu-workspace-command-${command.id}`,
              disabled: !command.enabled,
              onClick: () => {
                if (getWorkspaceCommands) void getWorkspaceCommands()?.executeAction(command.id);
                else void onWorkspaceCommand?.(command.id);
              },
            })),
            onClick: () => {},
          } satisfies MenuItem] : []),
          { label: t("tabs.mailUnified"), testId: "context-menu-item-mail-unified", icon: <Inbox className="w-3 h-3" />, onClick: () => onCommand("mail-unified") },
          { label: t("tabs.lanChat"), testId: "context-menu-item-lan-chat", icon: <MessageSquare className="w-3 h-3" />, onClick: () => onCommand("lan-chat") },
          { label: t("menu.mfa"), testId: "context-menu-item-mfa", icon: <KeyRound className="w-3 h-3" />, onClick: () => onCommand("mfa") },
          { label: t("menu.networkTools"), testId: "context-menu-item-network-tools", icon: <Wrench className="w-3 h-3" />, onClick: () => onCommand("tools") },
        ],
        onClick: () => {},
      },
      { label: t("menu.xserver"), testId: "context-menu-item-xserver", icon: <Monitor className="w-3 h-3" />, checked: xServerEnabled, onClick: () => onCommand("toggle-xserver") },
      { label: t("menu.settings"), testId: "context-menu-item-settings", icon: <Settings className="w-3 h-3" />, onClick: () => onCommand("settings") },
      { label: t("menu.help"), testId: "context-menu-item-help", icon: <HelpCircle className="w-3 h-3" />, onClick: () => onCommand("help") },
      { label: "", separator: true, onClick: () => {} },
      { label: t("ribbon.exit"), testId: "context-menu-item-exit", icon: <Power className="w-3 h-3" />, onClick: () => onCommand("exit"), danger: true },
    ]);
  };

  return (
    <div
      data-testid="control-bar"
      data-window-drag
      className="taomni-control-bar h-8 flex items-center min-w-0"
      onMouseDown={startWindowDrag}
    >
      {ctx.render}
      {previewNode}
      {IS_MAC && (
        <div className="shrink-0 self-stretch" style={{ width: MAC_TRAFFIC_LIGHT_INSET }} data-window-drag />
      )}
      <div className="flex items-center gap-1 px-1.5 shrink-0">
        {activeSideTab !== "home" && <BarButton
          testId="toggle-left-sidebar"
          title={`${t("platform.toggleLeftSidebar")} (${IS_MAC ? "Cmd+B" : "Ctrl+B"})`}
          icon={leftSidebarCollapsed ? <PanelRight className="w-4 h-4" /> : <PanelLeft className="w-4 h-4" />}
          active={!leftSidebarCollapsed}
          onClick={onToggleSidebar}
        />}
        {!nativeMenu && (
          menuHost ? createPortal(
            <BarButton testId="app-main-menu" title={t("compactTitleBar.mainMenu")} icon={<Menu className="w-4 h-4" />} onClick={openMainMenu} />,
            menuHost,
          ) : <BarButton testId="app-main-menu" title={t("compactTitleBar.mainMenu")} icon={<Menu className="w-4 h-4" />} onClick={openMainMenu} />
        )}
      </div>
      <WindowDragHandle />
      <div className="min-w-0 flex-1 self-stretch">
        {activeSideTab === "workspaces" ? (
          <div className="flex h-full min-w-0 items-center gap-1">
            <WorkspaceTabStrip />
          </div>
        ) : activeSideTab === "home" || activeSideTab === "agents" || activeSideTab === "tools" ? (
          <div className="flex h-full items-center gap-2 px-2 text-[12px] font-semibold" data-testid="platform-mode-title">
            {t(activeSideTab === "home" ? "platform.homeTitle" : activeSideTab === "tools" ? "platform.tools" : "platform.agentsTitle")}
          </div>
        ) : (
          <TabBar
            onStartLocalTerminal={onStartLocalTerminal}
            onConnectSession={onConnectSession}
            onOpenSessionEditor={onOpenSessionEditor}
            onDuplicateTab={onDuplicateTab}
          />
        )}
      </div>
      {/* Update hint sits just left of the tab-action group (centre-right of the
          bar). It only appears once a new version is staged. */}
      <UpdateHint />
      <PlatformToolbarActions onOpenSearch={onOpenGlobalSearch} slotRef={slotRef} onDetachActiveTab={onDetachActiveTab}>
        {activeSideTab === "sessions" && <TabMore onDetachActiveTab={onDetachActiveTab} />}
        {activeSideTab === "workspaces" && <WorkspaceTabsFilter />}
      </PlatformToolbarActions>
      {!IS_MAC && <WindowControls onClose={onCloseWindow} />}
    </div>
  );
}

/** Sessions filter and search share one compact entry. */
function TabMore({ onDetachActiveTab }: { onDetachActiveTab?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const filter = useAppStore((s) => s.tabFilter);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const primary = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!event.isComposing && primary && event.shiftKey && !event.altKey && event.key.toLowerCase() === "a") {
        event.preventDefault(); event.stopPropagation(); setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div ref={wrapRef} className="relative shrink-0 pr-1">
      <BarButton
        testId="tab-more"
        title={t("tabs.filterOpenTabs")}
        icon={<Filter className="w-4 h-4" />}
        active={Boolean(filter)}
        expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <OpenTabsMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        onDetachActiveTab={onDetachActiveTab}
        showActions={false}
      />
    </div>
  );
}

/** Non-intrusive update indicator: a small badge that appears only once a new
 *  version is available/staged. Clicking it opens the update window. */
function UpdateHint() {
  const t = useT();
  const status = useUpdateStore((s) => s.status);
  const version = useUpdateStore((s) => s.availableVersion);
  const openDialog = useUpdateStore((s) => s.openDialog);
  if (status !== "available" && status !== "ready") return null;
  const title = t("titlebar.updateAvailable", { version: version ?? "" });
  return (
    <BarButton
      testId="titlebar-update-available"
      title={title}
      onClick={openDialog}
      icon={
        <span className="relative inline-flex">
          <Download className="w-4 h-4" />
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full"
            style={{ background: "#e5534b", boxShadow: "0 0 0 1.5px var(--taomni-chrome-bg)" }}
          />
        </span>
      }
    />
  );
}

function BarButton({
  icon,
  title,
  onClick,
  testId,
  active,
  expanded,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: (event: React.MouseEvent) => void;
  testId?: string;
  active?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      aria-expanded={expanded}
      data-active={active || undefined}
      className="taomni-platform-toolbar-button w-7"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
