import {
  Bot,
  Boxes,
  FolderPlus,
  FolderTree,
  GitBranch,
  Home,
  KeyRound,
  ListTree,
  MessageSquare,
  MonitorSmartphone,
  MoreHorizontal,
  PanelsTopLeft,
  Settings,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { ScreenshotMenuButton } from "../screenshot/ScreenshotMenuButton";
import { ToolWindowRailButton, ToolWindowRailResizeHandle } from "../editor/workspace/panels/ToolWindowRail";
import { effectiveStripeWidth } from "../editor/workspace/toolWindowLayout";
import { useToolWindowStripeStore } from "../editor/workspace/toolWindowStripeStore";
import { useAppTheme } from "../../lib/appTheme";
import { useT } from "../../lib/i18n";
import { useAppStore, type PrimaryNavMode } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useWorkspacePlatformStore, type WorkspaceToolWindow } from "../../stores/workspacePlatformStore";
import { LanguageSwitcher } from "../window/LanguageSwitcher";
import { useAppThemeI18nLabel } from "../../lib/i18n/labels";

const THEME_ORDER = ["light", "dark", "system"] as const;

export interface PrimaryNavigationRailProps {
  compact?: boolean;
  /** Host for the active tab's own tool window buttons (ED-PARITY-027). */
  railHostRef?: (element: HTMLDivElement | null) => void;
  onOpenSettings?: () => void;
  onOpenWorkspaceSessionPicker?: () => void;
}

interface RailMode {
  mode: PrimaryNavMode;
  testId: string;
  label: string;
  icon: ReactNode;
}

/**
 * Window-primary navigation rail (v6.1 AC-02/AC-03/AC-04).
 *
 * Single vertical rail: primary modes on top, the Workspaces-only IDEA tool
 * window group in the middle, and the six global tools at the bottom. It never
 * grows a second column: the workspace canvas must not render another stripe.
 */
export function PrimaryNavigationRail({
  compact = false,
  railHostRef,
  onOpenSettings,
  onOpenWorkspaceSessionPicker,
}: PrimaryNavigationRailProps) {
  const t = useT();
  const { mode: themeMode, setMode: setThemeMode } = useAppTheme();
  const themeLabel = useAppThemeI18nLabel();
  const activeSideTab = useAppStore((s) => s.activeSideTab);
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const toggleFloatingMfa = useAppStore((s) => s.toggleFloatingMfa);
  const floatingMfaOpen = useAppStore((s) => s.floatingMfa.open);
  const toggleDrawer = useChatStore((s) => s.toggleDrawer);
  const chatDrawerOpen = useChatStore((s) => s.drawerOpen);
  const stripeSettings = useToolWindowStripeStore((s) => s.settings);
  const setStripeWidth = useToolWindowStripeStore((s) => s.setWidth);
  const toggleStripeNames = useToolWindowStripeStore((s) => s.toggleShowNames);
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const workspace = useWorkspacePlatformStore((s) => s.workspaces.find((candidate) => candidate.id === s.activeWorkspaceId));
  const setActiveLeftToolWindow = useWorkspacePlatformStore((s) => s.setActiveLeftToolWindow);
  const openGitTab = useWorkspacePlatformStore((s) => s.openGitTab);
  const setBottomDockTool = useWorkspacePlatformStore((s) => s.setBottomDockTool);
  const [railMenu, setRailMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);

  const showNames = stripeSettings.showNames;
  const isWorkspaces = activeSideTab === "workspaces";
  // While the legacy Code Workspace editor tab is active, its own tool window
  // rail merges into this rail (ED-PARITY-027) and provides these buttons; our
  // workspace group then stays hidden so no control is rendered twice.
  const legacyCodeTabActive = Boolean(
    workspace?.openTabs.some((tab) => tab.kind === "code" && tab.id === workspace.activeTabId),
  );
  const showWorkspaceTools = isWorkspaces && !legacyCodeTabActive;
  const modes: RailMode[] = [
    { mode: "home", testId: "nav-mode-home", label: t("platform.home"), icon: <Home /> },
    { mode: "workspaces", testId: "nav-mode-workspaces", label: t("platform.workspaces"), icon: <Boxes /> },
    { mode: "sessions", testId: "side-tab-sessions", label: t("sidebar.sideTabSessions"), icon: <PanelsTopLeft /> },
    { mode: "agents", testId: "nav-mode-agents", label: t("platform.agents"), icon: <Bot /> },
    { mode: "tools", testId: "side-tab-tools", label: t("sidebar.sideTabTools"), icon: <Wrench /> },
  ];

  const activateMode = (mode: PrimaryNavMode, clickCount = 0) => {
    if (clickCount > 1) {
      setSidebarCollapsed(true);
      return;
    }
    if (compact) {
      setActiveSideTab(mode);
      setSidebarCollapsed(false);
      return;
    }
    if (activeSideTab === mode) {
      setSidebarCollapsed(true);
      return;
    }
    setActiveSideTab(mode);
  };

  const activateWorkspaceTool = (toolWindow: WorkspaceToolWindow) => {
    setActiveSideTab("workspaces");
    setSidebarCollapsed(false);
    setActiveLeftToolWindow(activeWorkspaceId, toolWindow);
  };

  const openWorkspaceGit = () => {
    setActiveSideTab("workspaces");
    openGitTab(activeWorkspaceId);
  };

  const moreToolWindowItems: MenuItem[] = [
    { label: t("platform.terminal"), shortcut: "Alt+F12", testId: "code-workspace-tool-menu-terminal", onClick: () => setBottomDockTool(activeWorkspaceId, "terminal") },
    { label: t("platform.problems"), shortcut: "Alt+6", testId: "code-workspace-tool-menu-problems", onClick: () => setBottomDockTool(activeWorkspaceId, "problems") },
    { label: t("platform.runDebug"), shortcut: "Alt+4", testId: "code-workspace-tool-menu-run", onClick: () => setBottomDockTool(activeWorkspaceId, "run") },
    { label: t("platform.find"), testId: "code-workspace-tool-menu-find", onClick: () => setBottomDockTool(activeWorkspaceId, "find") },
    { label: t("platform.bookmarks"), testId: "code-workspace-tool-menu-bookmarks", onClick: () => setBottomDockTool(activeWorkspaceId, "bookmarks") },
    { label: t("platform.todo"), testId: "code-workspace-tool-menu-todo", onClick: () => setBottomDockTool(activeWorkspaceId, "todo") },
    { label: t("platform.services"), testId: "code-workspace-tool-menu-services", onClick: () => setBottomDockTool(activeWorkspaceId, "services") },
    { label: t("platform.database"), testId: "code-workspace-tool-menu-database", onClick: () => setBottomDockTool(activeWorkspaceId, "database") },
    { label: "", separator: true, onClick: () => undefined },
    {
      label: t("platform.showNames"),
      testId: "sidebar-rail-menu-show-names",
      checked: showNames,
      onClick: toggleStripeNames,
    },
    {
      label: t("platform.moveTo"),
      testId: "code-workspace-tool-menu-move",
      children: [
        { label: t("platform.moveToLeftTop"), testId: "code-workspace-tool-menu-move-left-top", onClick: () => undefined },
        { label: t("platform.moveToBottomLeft"), testId: "code-workspace-tool-menu-move-bottom-left", onClick: () => undefined },
        { label: t("platform.moveToRightTop"), testId: "code-workspace-tool-menu-move-right-top", onClick: () => undefined },
        { label: t("platform.moveToBottomRight"), testId: "code-workspace-tool-menu-move-bottom-right", onClick: () => undefined },
      ],
    },
  ];

  const openMoreMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMoreMenu({ x: rect.right + 4, y: Math.max(8, rect.top - 160) });
  };

  return (
    <>
      <div
        data-testid="sidebar-rail"
        data-show-names={showNames || undefined}
        className="relative flex min-h-0 flex-col shrink-0"
        style={{
          width: effectiveStripeWidth(stripeSettings, "left"),
          background: "var(--taomni-tab-inactive)",
          boxShadow: "inset -1px 0 0 var(--taomni-sidebar-border)",
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setRailMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <div data-testid="rail-mode-group" className="flex shrink-0 flex-col gap-1 px-1 py-1">
          {modes.map((entry) => (
            <ToolWindowRailButton
              key={entry.mode}
              item={{
                id: entry.mode,
                label: entry.label,
                icon: entry.icon,
                active: activeSideTab === entry.mode && !compact,
                testId: entry.testId,
                onSelect: () => activateMode(entry.mode),
              }}
              showNames={showNames}
              onClick={(event) => activateMode(entry.mode, event.detail)}
              onDoubleClick={(event) => {
                event.preventDefault();
                setSidebarCollapsed(true);
              }}
            />
          ))}
        </div>

        {showWorkspaceTools && (
          <div data-testid="workspace-merged-tool-rail" className="shrink-0 border-t px-1 py-1" style={{ borderColor: "var(--taomni-sidebar-border)" }}>
            <div
              data-testid="code-workspace-tool-rail-left"
              data-embedded="true"
              aria-label="Workspace tool windows"
              className="flex w-full flex-col items-stretch gap-1"
            >
              <ToolWindowRailButton
                item={{
                  id: "project",
                  label: t("platform.project"),
                  icon: <FolderTree />,
                  active: workspace?.activeLeftToolWindow === "project" && !compact,
                  shortcut: "Alt+1",
                  testId: "code-workspace-tool-rail-project",
                  onSelect: () => activateWorkspaceTool("project"),
                }}
                showNames={showNames}
                onClick={() => activateWorkspaceTool("project")}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  setSidebarCollapsed(true);
                }}
              />
              <ToolWindowRailButton
                item={{
                  id: "sessions",
                  label: t("platform.sessions"),
                  icon: <MonitorSmartphone />,
                  active: workspace?.activeLeftToolWindow === "sessions" && !compact,
                  shortcut: "Alt+2",
                  testId: "code-workspace-tool-rail-sessions",
                  onSelect: () => activateWorkspaceTool("sessions"),
                }}
                showNames={showNames}
                onClick={() => activateWorkspaceTool("sessions")}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  setSidebarCollapsed(true);
                }}
              />
              <ToolWindowRailButton
                item={{
                  id: "git",
                  label: t("platform.gitRepo"),
                  icon: <GitBranch />,
                  active: workspace?.activeTabId === `ws:${activeWorkspaceId}:git`,
                  shortcut: "Alt+9",
                  testId: "code-workspace-tool-rail-git",
                  onSelect: openWorkspaceGit,
                }}
                showNames={showNames}
                onClick={openWorkspaceGit}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  setSidebarCollapsed(true);
                }}
              />
              <ToolWindowRailButton
                item={{
                  id: "structure",
                  label: t("platform.structure"),
                  icon: <ListTree />,
                  active: workspace?.activeLeftToolWindow === "structure" && !compact,
                  shortcut: "Alt+7",
                  testId: "code-workspace-tool-rail-structure",
                  onSelect: () => activateWorkspaceTool("structure"),
                }}
                showNames={showNames}
                onClick={() => activateWorkspaceTool("structure")}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  setSidebarCollapsed(true);
                }}
              />
              <ToolWindowRailButton
                item={{
                  id: "more-tool-windows",
                  label: t("platform.moreToolWindows"),
                  icon: <MoreHorizontal />,
                  active: false,
                  testId: "code-workspace-bottom-tab-overflow",
                  onSelect: () => undefined,
                }}
                showNames={showNames}
                onClick={(event) => openMoreMenu(event as unknown as React.MouseEvent<HTMLButtonElement>)}
              />
            </div>
          </div>
        )}

        <div className="flex min-h-1 flex-1 flex-col">
          <div ref={railHostRef} data-testid="sidebar-tool-window-rail" className="flex min-h-0 flex-col" />
        </div>

        <div data-testid="rail-bottom-tools" className="flex shrink-0 flex-col gap-1 border-t px-1 pb-2 pt-1" style={{ borderColor: "var(--taomni-sidebar-border)" }}>
          <RailIconButton
            testId="rail-mfa-button"
            label={t("platform.mfaTitle")}
            active={floatingMfaOpen}
            showNames={showNames}
            onClick={toggleFloatingMfa}
          >
            <KeyRound className="w-[16px] h-[16px]" />
          </RailIconButton>
          <div className="flex w-full flex-col items-stretch">
            <ScreenshotMenuButton variant="rail" />
          </div>
          <RailIconButton
            testId="rail-chat-button"
            label={t("platform.chat")}
            active={chatDrawerOpen}
            showNames={showNames}
            onClick={toggleDrawer}
          >
            <MessageSquare className="w-[16px] h-[16px]" />
          </RailIconButton>
          <RailIconButton
            testId="theme-cycle"
            label={themeLabel(themeMode)}
            ariaLabel={t("titlebar.cycleThemeAria")}
            showNames={showNames}
            onClick={() => {
              const index = THEME_ORDER.indexOf(themeMode);
              setThemeMode(THEME_ORDER[(index + 1) % THEME_ORDER.length]);
            }}
          >
            <ThemeIcon mode={themeMode} />
          </RailIconButton>
          <div className="w-full">
            <LanguageSwitcher variant="rail" />
          </div>
          <RailIconButton
            testId="ribbon-settings"
            label={t("platform.settings")}
            showNames={showNames}
            onClick={() => onOpenSettings?.()}
          >
            <Settings className="w-[16px] h-[16px]" />
          </RailIconButton>
          {isWorkspaces && (
            <RailIconButton
              testId="rail-workspace-picker"
              label={t("platform.openAnySession")}
              showNames={showNames}
              onClick={() => onOpenWorkspaceSessionPicker?.()}
            >
              <FolderPlus className="w-[16px] h-[16px]" />
            </RailIconButton>
          )}
        </div>

        {stripeSettings.showNames && (
          <ToolWindowRailResizeHandle
            side="left"
            width={effectiveStripeWidth(stripeSettings, "left")}
            onResize={(width) => setStripeWidth("left", width)}
            testId="sidebar-rail-resize"
          />
        )}
      </div>
      {railMenu && (
        <ContextMenu
          x={railMenu.x}
          y={railMenu.y}
          onClose={() => setRailMenu(null)}
          items={[{
            label: t("sidebar.showToolWindowNames"),
            testId: "sidebar-rail-menu-show-names",
            checked: showNames,
            onClick: toggleStripeNames,
          }]}
        />
      )}
      {moreMenu && (
        <ContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          onClose={() => setMoreMenu(null)}
          items={moreToolWindowItems}
        />
      )}
    </>
  );
}

function ThemeIcon({ mode }: { mode: "light" | "dark" | "system" }) {
  if (mode === "dark") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[16px] h-[16px]" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }
  if (mode === "system") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[16px] h-[16px]" aria-hidden="true">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[16px] h-[16px]" aria-hidden="true">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
    </svg>
  );
}

function RailIconButton({
  testId,
  label,
  ariaLabel,
  active,
  showNames,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  ariaLabel?: string;
  active?: boolean;
  showNames: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel ?? label}
      aria-pressed={active}
      data-active={active || undefined}
      title={label}
      className="relative flex min-h-[32px] w-full shrink-0 flex-col items-center justify-center gap-0.5 rounded-md px-0 py-1 text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover)] hover:text-[var(--taomni-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--taomni-accent)] data-[active=true]:bg-[var(--taomni-selected)] data-[active=true]:text-[var(--taomni-accent)]"
      onClick={onClick}
    >
      <span aria-hidden="true" className="flex h-[20px] w-[20px] items-center justify-center [&>svg]:h-[16px] [&>svg]:w-[16px]">{children}</span>
      {showNames && <span className="w-full truncate px-0.5 text-center text-[10px] leading-[12px]">{label}</span>}
    </button>
  );
}
