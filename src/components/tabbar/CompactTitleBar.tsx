import {
  FolderOpen,
  HelpCircle,
  Menu,
  PanelLeft,
  Plus,
  RefreshCw,
  Settings,
  Terminal as TerminalIcon,
  Wrench,
  X,
  PanelTopOpen,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TabBar } from "./TabBar";
import { useContextMenu } from "../ContextMenu";
import { WindowControls } from "../window/WindowControls";
import { TitleBarTrayControls } from "../window/TitleBarTrayControls";
import type { RibbonCommand } from "../menubar/Ribbon";
import { useT } from "../../lib/i18n";
import type { LocalShellSelection } from "../../types";
import type { SessionConfig } from "../../lib/ipc";

type CompactCommand = RibbonCommand | "close-active" | "reload-sessions";

interface CompactTitleBarProps {
  activeTabClosable: boolean;
  onCommand: (command: CompactCommand) => void;
  onToggleSidebarDrawer: () => void;
  onStartLocalTerminal: (localShell?: LocalShellSelection) => void;
  onConnectSession: (session: SessionConfig) => void;
  onOpenSessionEditor: () => void;
}

export function CompactTitleBar({
  activeTabClosable,
  onCommand,
  onToggleSidebarDrawer,
  onStartLocalTerminal,
  onConnectSession,
  onOpenSessionEditor,
}: CompactTitleBarProps) {
  const ctx = useContextMenu();
  const t = useT();

  const startDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    if (!(event.target as HTMLElement).closest("[data-window-drag]")) return;
    void getCurrentWindow().startDragging().catch(() => {});
  };

  const openMainMenu = (event: React.MouseEvent) => {
    ctx.show(event, [
      { label: t("menu.newLocalTerminal"), icon: <TerminalIcon className="w-3 h-3" />, onClick: () => onCommand("new-terminal") },
      { label: t("menu.newRemoteSession"), icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
      { label: t("ribbon.newSftp"), icon: <FolderOpen className="w-3 h-3" />, onClick: () => onCommand("new-sftp") },
      { label: t("menu.closeActiveTab"), icon: <X className="w-3 h-3" />, onClick: () => onCommand("close-active"), disabled: !activeTabClosable },
      { label: "", separator: true, onClick: () => {} },
      {
        label: t("menu.sessions"),
        testId: "context-menu-item-sessions",
        icon: <PanelLeft className="w-3 h-3" />,
        children: [
          { label: t("sidebar.headerTitle"), icon: <PanelLeft className="w-3 h-3" />, onClick: onToggleSidebarDrawer },
          { label: t("menu.newSession"), icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
          { label: t("menu.reloadSessions"), icon: <RefreshCw className="w-3 h-3" />, onClick: () => onCommand("reload-sessions") },
        ],
        onClick: () => {},
      },
      {
        label: t("menu.view"),
        icon: <PanelTopOpen className="w-3 h-3" />,
        children: [
          { label: t("titlebar.exitCompact"), shortcut: "Ctrl+Shift+M", onClick: () => onCommand("toggle-compact") },
          { label: t("sidebar.headerTitle"), icon: <PanelLeft className="w-3 h-3" />, onClick: onToggleSidebarDrawer },
          { label: t("menu.splitTerminal"), onClick: () => onCommand("split") },
        ],
        onClick: () => {},
      },
      { label: t("ribbon.tunneling"), icon: <Wrench className="w-3 h-3" />, onClick: () => onCommand("tunneling") },
      { label: t("menu.settings"), icon: <Settings className="w-3 h-3" />, onClick: () => onCommand("settings") },
      { label: t("menu.help"), icon: <HelpCircle className="w-3 h-3" />, onClick: () => onCommand("help") },
      { label: "", separator: true, onClick: () => {} },
      { label: t("ribbon.exit"), onClick: () => onCommand("exit"), danger: true },
    ]);
  };

  return (
    <div
      data-testid="compact-titlebar"
      className="taomni-compact-titlebar h-8 flex items-center min-w-0"
      onMouseDown={startDrag}
    >
      {ctx.render}
      <div className="flex items-center gap-1 px-1.5 shrink-0">
        <TitleBarButton testId="compact-main-menu" title={t("compactTitleBar.mainMenu")} icon={<Menu className="w-4 h-4" />} onClick={openMainMenu} />
        <TitleBarButton testId="compact-sidebar-drawer-toggle" title={t("compactTitleBar.sessionsDrawer")} icon={<PanelLeft className="w-4 h-4" />} onClick={onToggleSidebarDrawer} />
      </div>
      <div className="min-w-0 flex-1 self-stretch">
        <TabBar
          onStartLocalTerminal={onStartLocalTerminal}
          onConnectSession={onConnectSession}
          onOpenSessionEditor={onOpenSessionEditor}
        />
      </div>
      <div data-window-drag className="w-10 self-stretch shrink-0" />
      <TitleBarTrayControls />
      <WindowControls />
    </div>
  );
}

function TitleBarButton({
  icon,
  title,
  onClick,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: (event: React.MouseEvent) => void;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      type="button"
      title={title}
      aria-label={title}
      className="h-6 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
