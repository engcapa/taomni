import {
  Boxes,
  Home,
  KeyRound,
  MessageSquare,
  PanelsTopLeft,
  Settings,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { ContextMenu } from "../ContextMenu";
import { ScreenshotMenuButton } from "../screenshot/ScreenshotMenuButton";
import { ToolWindowRailButton, ToolWindowRailResizeHandle } from "../editor/workspace/panels/ToolWindowRail";
import { effectiveStripeWidth } from "../editor/workspace/toolWindowLayout";
import { useToolWindowStripeStore } from "../editor/workspace/toolWindowStripeStore";
import { useAppTheme } from "../../lib/appTheme";
import { useT } from "../../lib/i18n";
import { useAppStore, type PrimaryNavMode } from "../../stores/appStore";
import { isChatCapableTabType, useChatStore } from "../../stores/chatStore";
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
}: PrimaryNavigationRailProps) {
  const t = useT();
  const setMenuHost = useMainRailHostStore((s) => s.setMenuHost);
  const { mode: themeMode, setMode: setThemeMode } = useAppTheme();
  const themeLabel = useAppThemeI18nLabel();
  const activeSideTab = useAppStore((s) => s.activeSideTab);
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const toggleFloatingMfa = useAppStore((s) => s.toggleFloatingMfa);
  const floatingMfaOpen = useAppStore((s) => s.floatingMfa.open);
  const toggleDrawer = useChatStore((s) => s.toggleDrawer);
  const chatDrawerOpen = useChatStore((s) => s.drawerOpen);
  const activeTab = useAppStore((s) => s.tabs.find((tab) => tab.id === s.activeTabId));
  const stripeSettings = useToolWindowStripeStore((s) => s.settings);
  const setStripeWidth = useToolWindowStripeStore((s) => s.setWidth);
  const toggleStripeNames = useToolWindowStripeStore((s) => s.toggleShowNames);
  const [railMenu, setRailMenu] = useState<{ x: number; y: number } | null>(null);
  const showNames = stripeSettings.showNames;
  // The shared editor owns workspace tools, including in an empty workspace.
  // It portals its real controls into railHostRef instead of duplicating them.
  const modes: RailMode[] = [
    { mode: "home", testId: "nav-mode-home", label: t("platform.home"), icon: <Home /> },
    { mode: "workspaces", testId: "nav-mode-workspaces", label: t("platform.workspaces"), icon: <Boxes /> },
    { mode: "sessions", testId: "side-tab-sessions", label: t("sidebar.sideTabSessions"), icon: <PanelsTopLeft /> },
    { mode: "tools", testId: "side-tab-tools", label: t("sidebar.sideTabTools"), icon: <Wrench /> },
  ];

  const activateMode = (mode: PrimaryNavMode, clickCount = 0) => {
    if (mode === "home") {
      setActiveSideTab("home");
      setSidebarCollapsed(true);
      return;
    }
    if (clickCount > 1) {
      setSidebarCollapsed(true);
      return;
    }
    if (compact) {
      setActiveSideTab(mode);
      return;
    }
    if (activeSideTab === mode) {
      setSidebarCollapsed(true);
      return;
    }
    setActiveSideTab(mode);
  };

  return (
    <>
      <div
        data-testid="sidebar-rail"
        data-show-names={showNames || undefined}
        className="relative flex min-h-0 flex-col shrink-0"
        style={{
          width: showNames ? effectiveStripeWidth(stripeSettings, "left") : 42,
          background: "var(--taomni-chrome-bg)",
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setRailMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <div ref={setMenuHost} data-testid="rail-app-menu-host" className="flex shrink-0 items-center justify-center" />
        <div data-testid="rail-mode-group" className="flex shrink-0 flex-col gap-1 px-1 py-1">
          {modes.map((entry) => (
            <ToolWindowRailButton
              key={entry.mode}
              item={{
                id: entry.mode,
                label: entry.label,
                icon: entry.icon,
                active: activeSideTab === entry.mode,
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

        <div className="flex min-h-1 flex-1 flex-col">
          <div ref={railHostRef} data-testid="sidebar-tool-window-rail" aria-label={t("platform.workspaceToolWindows")} title={t("platform.workspaceToolWindows")} className="taomni-ide-tool-group flex min-h-0 flex-col" />
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
            onClick={() => {
              if (activeSideTab === "sessions" && activeTab && isChatCapableTabType(activeTab.type)) {
                void useChatStore.getState().toggleTabChat(activeTab.chatTabId ?? activeTab.id);
              } else toggleDrawer();
            }}
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
            <LanguageSwitcher variant="rail" showLabel={showNames} />
          </div>
          <RailIconButton
            testId="ribbon-settings"
            label={t("platform.settings")}
            showNames={showNames}
            onClick={() => onOpenSettings?.()}
          >
            <Settings className="w-[16px] h-[16px]" />
          </RailIconButton>

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
