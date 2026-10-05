import {
  Search,
  Plus,
  Edit3,
  Copy,
  Trash2,
  RefreshCw,
  Star,
  Wrench,
  Settings,
  GitBranch,
  Server,
  Network,
  Shield,
  FileText,
  MessageSquare,
  Inbox,
  KeyRound,
  PanelsTopLeft,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { SessionTree } from "./SessionTree";
import { ConfirmDialog } from "./ConfirmDialog";
import { useAppStore, type SideTab } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import type { SessionConfig } from "../../lib/ipc";
import { useT, type TranslateFn } from "../../lib/i18n";
import type { AppCommand } from "../menubar/commands";
import { ContextMenu } from "../ContextMenu";
import { ToolWindowRailButton, ToolWindowRailResizeHandle } from "../editor/workspace/panels/ToolWindowRail";
import { effectiveStripeWidth } from "../editor/workspace/toolWindowLayout";
import { useToolWindowStripeStore } from "../editor/workspace/toolWindowStripeStore";

interface SidebarProps {
  onNewSession?: (groupPath?: string | null) => void;
  onNewSftpSession?: () => void;
  onEditSession?: (session: SessionConfig) => void;
  onConnectSession?: (session: SessionConfig) => void;
  onOpenSettings?: () => void;
  onCommand?: (command: AppCommand) => void;
  compact?: boolean;
  navigatorOnly?: boolean;
}

export function Sidebar({
  onNewSession,
  onEditSession,
  onConnectSession,
  onOpenSettings,
  onCommand,
  compact = false,
  navigatorOnly = false,
}: SidebarProps) {
  const {
    activeSideTab,
    setActiveSideTab,
    setSidebarCollapsed,
  } = useAppStore();
  const {
    sessions,
    selectedSessionIds,
    searchQuery,
    setSearchQuery,
    loadSessions,
    removeSessions,
    duplicateSessions,
    moveSessionsToGroup,
  } = useSessionStore();
  const t = useT();
  const setRailHost = useMainRailHostStore((state) => state.setHost);
  const stripeSettings = useToolWindowStripeStore((state) => state.settings);
  const setStripeWidth = useToolWindowStripeStore((state) => state.setWidth);
  const toggleStripeNames = useToolWindowStripeStore((state) => state.toggleShowNames);
  const [railMenu, setRailMenu] = useState<{ x: number; y: number } | null>(null);
  const selectedSessions = sessions.filter((session) => selectedSessionIds.includes(session.id));
  const selectionCount = selectedSessions.length;
  const [deleteConfirm, setDeleteConfirm] = useState<SessionConfig[] | null>(null);

  const handleDelete = () => {
    if (selectionCount === 0) return;
    setDeleteConfirm(selectedSessions);
  };

  const handleFavorite = () => {
    if (selectionCount === 0) return;
    void moveSessionsToGroup(selectedSessionIds, "User sessions / Favorites");
  };

  const handleSideTabClick = (tab: SideTab, clickCount = 0) => {
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

  const handleSideTabCollapse = (event: React.MouseEvent) => {
    event.preventDefault();
    setSidebarCollapsed(true);
  };

  const handleSideTabContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setRailMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <>
    <div data-testid="sidebar" className="h-full flex">
      {!navigatorOnly && <div
        data-testid="sidebar-rail"
        data-show-names={stripeSettings.showNames || undefined}
        className="relative flex min-h-0 flex-col shrink-0"
        style={{ width: effectiveStripeWidth(stripeSettings, "left"), background: "var(--taomni-tab-inactive)", boxShadow: "inset -1px 0 0 var(--taomni-sidebar-border)" }}
        onContextMenu={handleSideTabContextMenu}
      >
        <div className="flex shrink-0 flex-col gap-1 px-1 py-1">
          {(["sessions", "tools"] as const).map((tab) => {
            const label = labelForSideTab(t, tab);
            return (
              <ToolWindowRailButton
                key={tab}
                item={{
                  id: tab,
                  label,
                  icon: tab === "sessions" ? <PanelsTopLeft /> : <Wrench />,
                  active: activeSideTab === tab && !compact,
                  testId: `side-tab-${tab}`,
                  onSelect: () => handleSideTabClick(tab),
                }}
                showNames={stripeSettings.showNames}
                onClick={(event) => handleSideTabClick(tab, event.detail)}
                onDoubleClick={handleSideTabCollapse}
              />
            );
          })}
        </div>
        {compact ? (
          // ED-PARITY-027 B: the active tab's tool window buttons render here.
          <div
            ref={setRailHost}
            data-testid="sidebar-tool-window-rail"
            className="flex min-h-0 flex-1 flex-col"
          />
        ) : (
          <div className="flex-1" />
        )}
        <div
          className="shrink-0 border-t px-1 pb-2 pt-1"
          style={{ borderColor: "var(--taomni-sidebar-border)" }}
        >
          <ToolWindowRailButton
            item={{
              id: "settings",
              label: t("menu.settings"),
              icon: <Settings />,
              active: false,
              testId: "ribbon-settings",
              onSelect: () => onOpenSettings?.(),
            }}
            showNames={stripeSettings.showNames}
          />
        </div>
        {stripeSettings.showNames && (
          <ToolWindowRailResizeHandle
            side="left"
            width={effectiveStripeWidth(stripeSettings, "left")}
            onResize={(width) => setStripeWidth("left", width)}
            testId="sidebar-rail-resize"
          />
        )}
      </div>}
      {compact && null}
      {!compact && (
      <div className="flex-1 flex flex-col min-w-0" style={{ background: "var(--taomni-sidebar-bg)", borderRight: "1px solid var(--taomni-sidebar-border)" }}>
        <div className="flex-1 flex flex-col min-h-0" style={{ display: activeSideTab === "sessions" ? "flex" : "none" }} inert={activeSideTab !== "sessions"}>
            <div className="h-7 flex items-center gap-1 px-1.5 border-b shrink-0" style={{ borderColor: "var(--taomni-divider)" }}>
              <IconBtn testId="session-new" title={t("sidebar.newSessionTitle")} icon={<Plus className="w-3.5 h-3.5" />} onClick={() => onNewSession?.()} />
              <IconBtn testId="session-edit" title={t("sidebar.editTitle")} icon={<Edit3 className="w-3.5 h-3.5" />} onClick={() => selectionCount === 1 && onEditSession?.(selectedSessions[0])} disabled={selectionCount !== 1} />
              <IconBtn testId="session-duplicate" title={t("sidebar.duplicateTitle")} icon={<Copy className="w-3.5 h-3.5" />} onClick={() => selectionCount > 0 && void duplicateSessions(selectedSessionIds)} disabled={selectionCount === 0} />
              <IconBtn testId="session-delete" title={t("sidebar.deleteTitle")} icon={<Trash2 className="w-3.5 h-3.5" />} onClick={handleDelete} disabled={selectionCount === 0} />
              <span className="taomni-divider-v h-4 mx-1" />
              <IconBtn title={t("sidebar.refreshTitle")} icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => void loadSessions()} />
              <IconBtn title={t("sidebar.favoriteTitle")} icon={<Star className="w-3.5 h-3.5" />} onClick={handleFavorite} disabled={selectionCount === 0} />
              <div className="flex-1" />
              <div className="relative">
                <Search className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
                <input
                  type="search"
                  data-testid="session-search"
                  aria-label={t("sidebar.searchSessions")}
                  className="taomni-input pl-6 w-[140px]"
                  style={{ paddingLeft: "24px" }}
                  placeholder={t("sidebar.searchPlaceholder")}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </div>
            </div>
            <SessionTree onNewSession={onNewSession} onConnectSession={onConnectSession} onEditSession={onEditSession} />
        </div>
        <div className="flex-1 flex flex-col min-h-0" style={{ display: activeSideTab === "tools" ? "flex" : "none" }} inert={activeSideTab !== "tools"}>
          <ToolsPanel onCommand={onCommand} />
        </div>
      </div>
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
          checked: stripeSettings.showNames,
          onClick: toggleStripeNames,
        }]}
      />
    )}
    {deleteConfirm && (
      <ConfirmDialog
        title={t("sidebar.confirmDeleteSessionTitle")}
        message={
          deleteConfirm.length === 1
            ? t("sidebar.confirmDeleteSession", { name: deleteConfirm[0].name })
            : t("sidebar.confirmDeleteSessions", { count: deleteConfirm.length })
        }
        confirmLabel={t("common.delete")}
        danger
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
          const ids = deleteConfirm.map((session) => session.id);
          setDeleteConfirm(null);
          void removeSessions(ids);
        }}
      />
    )}
    </>
  );
}

/** Tool entries mirror the main menu Tools items (without packages/macros). */
function ToolsPanel({ onCommand }: { onCommand?: (command: AppCommand) => void }) {
  const t = useT();
  const items: Array<{
    id: AppCommand;
    label: string;
    icon: ReactNode;
    testId: string;
  }> = [
    {
      id: "servers",
      label: t("servers.dialogTitle"),
      icon: <Server className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-servers",
    },
    {
      id: "tunneling",
      label: t("menu.tunneling"),
      icon: <Network className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-tunneling",
    },
    {
      id: "sockscap",
      label: t("menu.sockscap"),
      icon: <Shield className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-sockscap",
    },
    {
      id: "git",
      label: t("menu.gitRepository"),
      icon: <GitBranch className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-git",
    },
    {
      id: "code-workspace",
      label: t("menu.codeWorkspace"),
      icon: <FileText className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-code-workspace",
    },
    {
      id: "mail-unified",
      label: t("tabs.mailUnified"),
      icon: <Inbox className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-mail-unified",
    },
    {
      id: "lan-chat",
      label: t("tabs.lanChat"),
      icon: <MessageSquare className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-lan-chat",
    },
    {
      id: "mfa",
      label: t("menu.mfa"),
      icon: <KeyRound className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-mfa",
    },
    {
      id: "tools",
      label: t("menu.networkTools"),
      icon: <Wrench className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-network-tools",
    },
  ];

  return (
    <div data-testid="sidebar-tools-panel" className="flex-1 flex flex-col min-h-0">
      <div
        className="h-7 flex items-center gap-1.5 px-2 border-b shrink-0 font-semibold text-[var(--taomni-text)]"
        style={{ borderColor: "var(--taomni-divider)", fontSize: "var(--taomni-ui-font-size)" }}
      >
        <Wrench className="w-3.5 h-3.5" />
        {t("sidebar.utilityToolsTitle")}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={item.testId}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
            style={{ fontSize: "var(--taomni-ui-font-size)" }}
            onClick={() => onCommand?.(item.id)}
          >
            <span className="text-[var(--taomni-text-muted)]">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function IconBtn({
  icon,
  title,
  testId,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  title: string;
  testId?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:cursor-default"
      type="button"
    >
      {icon}
    </button>
  );
}

function labelForSideTab(t: TranslateFn, tab: SideTab): string {
  switch (tab) {
    case "sessions":
      return t("sidebar.sideTabSessions");
    case "tools":
      return t("sidebar.sideTabTools");
  }
}
