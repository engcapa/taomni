import { useState } from "react";
import {
  Bot,
  FolderTree,
  GitBranch,
  Home,
  KeyRound,
  Layers,
  ListTree,
  MessageSquare,
  Monitor,
  Moon,
  PanelsTopLeft,
  Settings,
  Sun,
  Wrench,
} from "lucide-react";
import { ContextMenu, useContextMenu, type MenuItem } from "../ContextMenu";
import { ScreenshotMenuButton } from "../screenshot/ScreenshotMenuButton";
import { LanguageSwitcher } from "../window/LanguageSwitcher";
import { ToolWindowRailButton, ToolWindowRailResizeHandle } from "../editor/workspace/panels/ToolWindowRail";
import { effectiveStripeWidth, TOOL_WINDOW_ANCHORS, TOOL_WINDOW_ANCHOR_LABELS } from "../editor/workspace/toolWindowLayout";
import { useToolWindowStripeStore } from "../editor/workspace/toolWindowStripeStore";
import { useAppTheme, type AppThemeMode } from "../../lib/appTheme";
import { useT, type TranslateFn } from "../../lib/i18n";
import { useAppStore, type SideTab } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { useWorkspaceToolBridgeStore } from "../../stores/workspaceToolBridgeStore";
import { useWorkspaceGitSummaryStore } from "../../stores/workspaceGitSummaryStore";

const THEME_MODES: Array<{ mode: AppThemeMode; icon: React.ReactNode }> = [
  { mode: "light", icon: <Sun className="w-[16px] h-[16px]" /> },
  { mode: "dark", icon: <Moon className="w-[16px] h-[16px]" /> },
  { mode: "system", icon: <Monitor className="w-[16px] h-[16px]" /> },
];

const PRIMARY_MODES: SideTab[] = ["home", "workspaces", "sessions", "agents", "tools"];

const MODE_TEST_IDS: Record<SideTab, string> = {
  home: "nav-mode-home",
  workspaces: "nav-mode-workspaces",
  sessions: "side-tab-sessions",
  agents: "nav-mode-agents",
  tools: "side-tab-tools",
};

export function modeTestIdFor(tab: SideTab): string {
  return MODE_TEST_IDS[tab];
}

export function labelForSideTab(t: TranslateFn, tab: SideTab): string {
  switch (tab) {
    case "home": return t("sidebar.sideTabHome");
    case "workspaces": return t("sidebar.sideTabWorkspaces");
    case "sessions": return t("sidebar.sideTabSessions");
    case "agents": return t("sidebar.sideTabAgents");
    case "tools": return t("sidebar.sideTabTools");
  }
}

interface PrimaryNavigationRailProps {
  compact: boolean;
  onOpenSettings?: () => void;
}

/**
 * Workspace-first platform navigation rail (v6.1): the window's single
 * primary rail. Top: the five first-class modes (Home first). Middle: the
 * Workspaces-mode contextual IDEA tool window buttons. Bottom: the six
 * global tools (MFA, screenshot, chat, theme, language, settings).
 */
export function PrimaryNavigationRail({ compact, onOpenSettings }: PrimaryNavigationRailProps) {
  const t = useT();
  const { activeSideTab, setActiveSideTab, setSidebarCollapsed } = useAppStore();
  const stripeSettings = useToolWindowStripeStore((state) => state.settings);
  const setRailHost = useMainRailHostStore((state) => state.setHost);
  const [railMenu, setRailMenu] = useState<{ x: number; y: number } | null>(null);

  const handleModeClick = (tab: SideTab, clickCount = 0) => {
    // The first click can swap the expanded Sidebar for its compact mount.
    // Keep the second click of the same gesture from reopening that panel.
    if (clickCount > 1) {
      setSidebarCollapsed(true);
      return;
    }
    if (compact) {
      setActiveSideTab(tab);
      setSidebarCollapsed(false);
      return;
    }
    if (activeSideTab === tab) {
      setSidebarCollapsed(true);
      return;
    }
    setActiveSideTab(tab);
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setRailMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <div
      data-testid="sidebar-rail"
      data-show-names={stripeSettings.showNames || undefined}
      className="relative flex min-h-0 flex-col shrink-0"
      style={{ width: effectiveStripeWidth(stripeSettings, "left"), background: "var(--taomni-tab-inactive)", boxShadow: "inset -1px 0 0 var(--taomni-sidebar-border)" }}
      onContextMenu={handleContextMenu}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto taomni-scroll-y">
        <div className="flex shrink-0 flex-col gap-1 px-1 py-1">
          {PRIMARY_MODES.map((tab) => (
            <ToolWindowRailButton
              key={tab}
              item={{
                id: tab,
                label: labelForSideTab(t, tab),
                icon: <ModeIcon tab={tab} />,
                active: activeSideTab === tab && !compact,
                testId: MODE_TEST_IDS[tab],
                onSelect: () => handleModeClick(tab),
              }}
              showNames={stripeSettings.showNames}
              onClick={(event) => handleModeClick(tab, event.detail)}
              onDoubleClick={(event) => {
                event.preventDefault();
                setSidebarCollapsed(true);
              }}
            />
          ))}
        </div>
        {activeSideTab === "workspaces" && <WorkspaceContextRail showNames={stripeSettings.showNames} />}
        {compact && (
          // ED-PARITY-027 B: the active tab's tool window buttons render here
          // when the sidebar collapses outside the Workspaces mode.
          <div
            ref={setRailHost}
            data-testid="sidebar-tool-window-rail"
            className="flex min-h-0 flex-1 flex-col"
          />
        )}
      </div>
      <div
        className="shrink-0 border-t px-1 pb-2 pt-1"
        style={{ borderColor: "var(--taomni-sidebar-border)" }}
      >
        <RailBottomTools onOpenSettings={onOpenSettings} />
      </div>
      {stripeSettings.showNames && (
        <ToolWindowRailResizeHandle
          side="left"
          width={effectiveStripeWidth(stripeSettings, "left")}
          onResize={(width) => useToolWindowStripeStore.getState().setWidth("left", width)}
          testId="sidebar-rail-resize"
        />
      )}
      {railMenu && (
        <ContextMenu
          x={railMenu.x}
          y={railMenu.y}
          onClose={() => setRailMenu(null)}
          items={[{
            label: t("sidebar.showToolWindowNames"),
            testId: "sidebar-rail-menu-show-names",
            checked: stripeSettings.showNames,
            onClick: () => useToolWindowStripeStore.getState().toggleShowNames(),
          }]}
        />
      )}
    </div>
  );
}

function ModeIcon({ tab }: { tab: SideTab }) {
  switch (tab) {
    case "home": return <Home />;
    case "workspaces": return <Layers />;
    case "sessions": return <PanelsTopLeft />;
    case "agents": return <Bot />;
    case "tools": return <Wrench />;
  }
}

/** Contextual IDEA tool window buttons, fused into the rail in Workspaces mode. */
function WorkspaceContextRail({ showNames }: { showNames: boolean }) {
  const t = useT();
  const ctx = useContextMenu();
  const { sidebarCollapsed, setSidebarCollapsed } = useAppStore();
  const activeWorkspaceId = useWorkspacePlatformStore((s) => s.activeWorkspaceId);
  const workspace = useWorkspacePlatformStore((s) => s.workspaces.find((ws) => ws.id === s.activeWorkspaceId));
  const setLeftToolWindow = useWorkspacePlatformStore((s) => s.setLeftToolWindow);
  const openGitPanel = useWorkspacePlatformStore((s) => s.openGitPanel);
  const bridge = useWorkspaceToolBridgeStore((s) => s.controller);
  const gitSummary = useWorkspaceGitSummaryStore((s) => s.summary);
  const lens = workspace?.activeLeftToolWindow ?? "project";
  const activeTab = workspace?.openTabs.find((tab) => tab.id === workspace.activeTabId);
  const workspaceId = activeWorkspaceId;

  const toggleLens = (tool: "project" | "sessions" | "structure") => {
    if (!sidebarCollapsed && lens === tool) {
      setSidebarCollapsed(true);
      return;
    }
    setLeftToolWindow(workspaceId, tool);
    if (sidebarCollapsed) setSidebarCollapsed(false);
  };

  // The Project tool window is the editor's own pane; select the sidebar lens
  // too so the rail and the sidebar never point at different surfaces.
  const toggleProjectTree = () => {
    setLeftToolWindow(workspaceId, "project");
    if (sidebarCollapsed) setSidebarCollapsed(false);
    if (bridge) bridge.toggleProjectTree();
  };

  const overflowItems: MenuItem[] = [
    { label: "Terminal (Alt+F12)", testId: "code-workspace-bottom-tab-overflow-terminal", onClick: () => bridge?.openBottomTool("terminal") },
    { label: "Problems (Alt+6)", testId: "code-workspace-bottom-tab-overflow-problems", onClick: () => bridge?.openBottomTool("problems") },
    { label: "Run / Debug (Alt+4)", testId: "code-workspace-bottom-tab-overflow-run", onClick: () => bridge?.openBottomTool("run") },
    { label: "Find", testId: "code-workspace-bottom-tab-overflow-search", onClick: () => bridge?.openBottomTool("search") },
    // No corresponding bottom-dock tab exists yet; keep the IDEA menu shape but
    // do not open an empty dock (v6.1 review M6).
    { label: "Bookmarks", testId: "code-workspace-bottom-tab-overflow-bookmarks", disabled: true, onClick: () => {} },
    { label: "TODO", testId: "code-workspace-bottom-tab-overflow-todos", onClick: () => bridge?.openBottomTool("todos") },
    { label: "Services", testId: "code-workspace-bottom-tab-overflow-services", disabled: true, onClick: () => {} },
    { label: "Database", testId: "code-workspace-bottom-tab-overflow-database", disabled: true, onClick: () => {} },
    { label: "", separator: true, onClick: () => {} },
    {
      label: t("sidebar.showToolWindowNames"),
      testId: "code-workspace-tool-rail-menu-show-names",
      checked: showNames,
      onClick: () => useToolWindowStripeStore.getState().toggleShowNames(),
    },
    {
      label: t("sidebar.moveToolWindowTo"),
      testId: "code-workspace-bottom-tab-overflow-move",
      disabled: !bridge,
      children: TOOL_WINDOW_ANCHORS.map((anchor) => ({
        label: TOOL_WINDOW_ANCHOR_LABELS[anchor],
        testId: `code-workspace-bottom-tab-overflow-move-${anchor}`,
        onClick: () => bridge?.moveProjectWindow(anchor),
      })),
      onClick: () => {},
    },
  ];

  return (
    <div
      data-testid="workspace-merged-tool-rail"
      className="flex min-h-0 shrink-0 flex-col"
    >
      <div data-testid="code-workspace-tool-rail-left" data-fused="" className="flex shrink-0 flex-col gap-1 border-t px-1 py-1" style={{ borderColor: "var(--taomni-sidebar-border)" }}>
        <ToolWindowRailButton
          item={{
            id: "project",
            label: t("sidebar.workspaceToolProject"),
            icon: <FolderTree />,
            active: bridge ? bridge.leftToolAreaOpen : lens === "project" && !sidebarCollapsed,
            shortcut: "Alt+1",
            testId: "code-workspace-tool-rail-project",
            onSelect: toggleProjectTree,
          }}
          showNames={showNames}
        />
        <ToolWindowRailButton
          item={{
            id: "sessions",
            label: t("sidebar.workspaceToolSessions"),
            icon: <PanelsTopLeft />,
            active: lens === "sessions" && !sidebarCollapsed,
            shortcut: "Alt+2",
            testId: "code-workspace-tool-rail-sessions",
            onSelect: () => toggleLens("sessions"),
          }}
          showNames={showNames}
        />
        <ToolWindowRailButton
          item={{
            id: "git",
            label: t("sidebar.workspaceToolGit"),
            icon: <GitBranch />,
            active: activeTab?.kind === "git",
            shortcut: "Alt+9",
            testId: "code-workspace-tool-rail-git",
            badge: gitSummary.changeCount > 0 ? gitSummary.changeCount : undefined,
            onSelect: () => openGitPanel(workspaceId),
          }}
          showNames={showNames}
        />
        <ToolWindowRailButton
          item={{
            id: "structure",
            label: t("sidebar.workspaceToolStructure"),
            icon: <ListTree />,
            active: lens === "structure" && !sidebarCollapsed,
            shortcut: "Alt+7",
            testId: "code-workspace-tool-rail-structure",
            onSelect: () => toggleLens("structure"),
          }}
          showNames={showNames}
        />
        <ToolWindowRailButton
          item={{
            id: "more",
            label: t("sidebar.workspaceToolMore"),
            icon: <span className="text-[15px] leading-none">⋯</span>,
            active: bridge?.bottomDockOpen === true,
            testId: "code-workspace-bottom-tab-overflow",
            onSelect: () => undefined,
          }}
          showNames={showNames}
          onClick={(event) => ctx.show(event, overflowItems)}
        />
      </div>
      {ctx.render}
    </div>
  );
}

/** Bottom global tools: MFA → screenshot → chat → theme → language → settings. */
function RailBottomTools({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const t = useT();
  const { mode, setMode } = useAppTheme();
  const floatingMfaOpen = useAppStore((s) => s.floatingMfa.open);
  const toggleDrawer = useChatStore((s) => s.toggleDrawer);
  const chatDrawerOpen = useChatStore((s) => s.drawerOpen);
  const showNames = useToolWindowStripeStore((s) => s.settings.showNames);

  const currentIndex = THEME_MODES.findIndex((item) => item.mode === mode);
  const current = THEME_MODES[currentIndex] ?? THEME_MODES[0];
  const next = THEME_MODES[(currentIndex + 1) % THEME_MODES.length] ?? THEME_MODES[0];

  return (
    <div data-testid="rail-bottom-tools" className="flex flex-col gap-1">
      <ToolWindowRailButton
        item={{
          id: "rail-mfa",
          label: t("sidebar.railMfa"),
          icon: <KeyRound />,
          active: floatingMfaOpen,
          testId: "rail-mfa-button",
          onSelect: () => useAppStore.getState().toggleFloatingMfa(),
        }}
        showNames={showNames}
      />
      <div data-testid="rail-screenshot-slot" className="flex flex-col items-stretch">
        <ScreenshotMenuButton menuUp vertical />
      </div>
      <ToolWindowRailButton
        item={{
          id: "rail-chat",
          label: t("sidebar.railChat"),
          icon: <MessageSquare />,
          active: chatDrawerOpen,
          testId: "rail-chat-button",
          onSelect: () => toggleDrawer(),
        }}
        showNames={showNames}
      />
      <ToolWindowRailButton
        item={{
          id: "theme-cycle",
          label: t("titlebar.cycleThemeAria"),
          icon: current.icon,
          active: false,
          testId: "theme-cycle",
          onSelect: () => setMode(next.mode),
        }}
        showNames={showNames}
      />
      <div data-testid="rail-language-slot" className="flex flex-col items-stretch">
        <LanguageSwitcher openUp rail={showNames} />
      </div>
      <ToolWindowRailButton
        item={{
          id: "settings",
          label: t("menu.settings"),
          icon: <Settings />,
          active: false,
          testId: "ribbon-settings",
          onSelect: () => onOpenSettings?.(),
        }}
        showNames={showNames}
      />
    </div>
  );
}
