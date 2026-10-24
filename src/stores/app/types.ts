import type { CodeWorkspaceRootKind, GitTabInfo, RecentWorkspace, Tab } from "../../types";
import { type XServerStatus } from "../../lib/ipc";
import type { TabFilter } from "../../lib/tabFilter";
import { type SidebarCollapsedByGroup } from "../sidebarRailPolicy";

/**
 * Primary navigation modes of the workspace-first shell (v6.1).
 *
 * `sessions`/`tools` keep their historical names and behaviour so existing
 * automation and stored preferences stay valid; `home`, `workspaces` and
 * `agents` extend the same rail.
 */
export type PrimaryNavMode = "home" | "workspaces" | "sessions" | "agents" | "tools";

/** Backwards-compatible alias for the former two-value sidebar tab type. */
export type SideTab = PrimaryNavMode;

/** Bottom-left floating MFA authenticator window (position is viewport-fixed). */
export interface FloatingMfaWindowState {
  open: boolean;
  pinned: boolean;
  /** Default placement: `{ left: 50, bottom: 30 }`. */
  position: { left: number; bottom: number };
  searchQuery: string;
}

export type TerminalSplitLayout = "horizontal" | "vertical" | "grid";

export type VaultUnlockMode = "startup" | "on-demand";

export type DbObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "procedure"
  | "function"
  | "trigger"
  | "event"
  | "sequence"
  | "dictionary";

export interface DbSelectedObject {
  catalog: string | null;
  schema: string | null;
  name: string;
  kind: DbObjectKind;
}

export interface CodeWorkspaceContext {
  /** Legacy primary root context kept for compatibility with existing tabs. */
  repoRoot: string;
  activePath: string | null;
  openPaths: string[];
  dirtyPaths: string[];
  roots?: CodeWorkspaceRootContext[];
  looseFiles?: CodeWorkspaceLooseFileContext[];
  activeFile?: CodeWorkspaceFileContext | null;
  openFiles?: CodeWorkspaceFileContext[];
  dirtyFiles?: CodeWorkspaceFileContext[];
  lsp?: CodeWorkspaceLspContext | null;
}

export type DuplicateTabOverrides = {
  terminalInitialCwd?: string;
  terminalProfile?: Tab["terminalProfile"];
  terminalTitlePrefix?: string;
};

export type TerminalActivityState =
  | "connecting"
  | "idle"
  | "running"
  | "disconnected"
  | "unknown";

export interface TerminalRuntimeInfo {
  backendSessionId?: string;
  state: TerminalActivityState;
  program?: string;
  activitySource?: "shell-integration" | "input-heuristic" | "process-probe";
  updatedAt: number;
}

export interface CodeWorkspaceRootContext {
  id: string;
  name: string;
  path: string;
  kind: CodeWorkspaceRootKind;
}

export interface CodeWorkspaceLooseFileContext {
  id: string;
  name: string;
  path: string;
}

export type CodeWorkspaceFileContext =
  | {
      kind: "root";
      rootId: string;
      rootName?: string;
      rootPath?: string;
      path: string;
    }
  | {
      kind: "loose";
      id: string;
      name?: string;
      path: string;
    };

export interface CodeWorkspaceLspContext {
  activeStatus?: CodeWorkspaceLspStatusContext | null;
  diagnostics: CodeWorkspaceLspDiagnosticContext[];
}

export interface CodeWorkspaceLspStatusContext {
  displayName?: string | null;
  languageId?: string | null;
  active: boolean;
  available: boolean;
  selectedCommand?: string | null;
  installHint?: string | null;
  error?: string | null;
}

export interface CodeWorkspaceLspDiagnosticContext {
  file: CodeWorkspaceFileContext;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  messages: string[];
}

export interface AppState {
  tabs: Tab[];
  activeTabId: string | null;
  sidebarCollapsed: boolean;
  /**
   * ED-PARITY-027: merge the active tab's tool window bar into the sidebar
   * rail and remember the sidebar state per tab group (default on).
   */
  mergeToolWindowRail: boolean;
  /** Sidebar collapsed state remembered per tab group (see sidebarRailPolicy). */
  sidebarCollapsedByGroup: SidebarCollapsedByGroup;
  activeSideTab: SideTab;
  /** Right context sidebar (`◨`, AI / session assist) collapsed state. */
  rightSidebarCollapsed: boolean;
  /** Bottom-left floating MFA authenticator window (v6.1 AC-04). */
  floatingMfa: FloatingMfaWindowState;
  /**
   * Whether a usable local X server is reachable (Xorg / XQuartz / VcXsrv /
   * WSLg). This is now backed by real backend detection via
   * {@link refreshXServer}, not a manual toggle — the value reflects whether
   * forwarded X11 apps actually have somewhere to display.
   */
  xServerEnabled: boolean;
  /** Full detection result for the local X server (null until first probe). */
  xServerStatus: XServerStatus | null;
  statusMessage: string;
  multiExecActive: boolean;
  multiExecSelectedTabIds: Set<string>;
  terminalSplitActive: boolean;
  terminalSplitLayout: TerminalSplitLayout;
  terminalSplitInputLockedTabIds: Set<string>;
  uiFontFamily: string;
  uiFontSize: number;
  vaultUnlockMode: VaultUnlockMode;
  welcomeRecentSessionLimit: number;
  recentWorkspaces: RecentWorkspace[];
  recentWorkspaceIdByWorkspaceInstance: Record<string, string>;
  /**
   * Transient focus filter for the open-tab strip (issue #121). When set, the
   * strip only renders tabs matching the filter; the rest are hidden, not
   * closed. Session-scoped — reset on reload and cleared whenever a new tab is
   * opened so the new tab is always visible.
   */
  tabFilter: TabFilter | null;

  /**
   * Latest known working directory per terminal tab id, mirrored from the
   * terminal's OSC-7 cwd reports (MainLayout.handleTerminalCwd). Ephemeral —
   * used by the AI chat store to tell Claude Code the bound terminal's live
   * cwd each turn (Phase 3.3). Keyed by tab id; absent until the shell first
   * reports a cwd, or for shells that can't (e.g. cmd.exe).
   */
  cwdByTab: Record<string, string>;

  /** Live connection/activity facts kept separate from persistent tab data. */
  terminalRuntimeByTab: Record<string, TerminalRuntimeInfo>;

  /**
   * Live DB-client runtime connection id per tab (Phase 6). The DB/Redis tab
   * generates this id when it connects (`createRuntimeDbSessionId`) and the
   * backend can't derive it, so we mirror it here keyed by tab id; the chat
   * store reads it to bridge `bound_db_connection_id` to the CC DB MCP each
   * turn. Absent until the tab connects; cleared on disconnect/unmount.
   */
  dbConnByTab: Record<string, string>;

  /**
   * Current objects selected in a DB tab's left schema tree. Ephemeral and keyed
   * by DB tab id; bridged into AI chat turns so SQL MCP tools can resolve
   * phrases such as "selected tables" without guessing. This can include
   * tables, views, routines, triggers, and other engine-specific object kinds.
   */
  dbSelectedObjectsByTab: Record<string, DbSelectedObject[]>;

  /**
   * Current code-workspace editor state keyed by tab id. Bridged into local
   * agent turns so Claude Code/Codex app-server know the active repo and files.
   */
  codeWorkspaceByTab: Record<string, CodeWorkspaceContext>;

  /**
   * Whether SQL run by the in-app AI/Claude Code agent is echoed into the
   * linked query tab's editor (appended, never auto-run). Toggled from the chat
   * drawer; persisted to localStorage, default on.
   */
  sqlEcho: boolean;

  addTab: (tab: Tab) => void;
  /**
   * Duplicate an existing tab, inserting the copy immediately to the right of
   * the original (not at the end of the strip) and activating it. See issue
   * #120: a duplicated session should sit next to its source for quick
   * switching/comparison.
   *
   * The copy's title gets a `-<n>` suffix that increments across all open tabs
   * sharing the same base name (so duplicating "Server" yields "Server-1",
   * then "Server-2", and duplicating "Server-1" continues the same family).
   * `overrides.terminalInitialCwd`, when provided, is carried onto the copy so
   * a duplicated local/SSH terminal can open in the source terminal's cwd.
   * `overrides.terminalProfile` carries the source tab's live appearance.
   */
  duplicateTab: (id: string, overrides?: DuplicateTabOverrides) => void;
  removeTab: (id: string) => void;
  removeTabs: (ids: string[]) => void;
  updateTabTitle: (id: string, title: string) => void;
  /** Patch a VNC tab's connection info (Properties / remembered credentials). */
  updateTabVnc: (id: string, patch: Partial<NonNullable<Tab["vnc"]>>) => void;
  /** Resolve or refresh an automatic terminal title from a valid cwd report. */
  assignTerminalAutoTitle: (tabId: string, cwd: string) => void;
  updateGitTabInfo: (id: string, git: GitTabInfo, title?: string) => void;
  setActiveTab: (id: string) => void;
  moveTab: (fromId: string, targetId: string, position: "before" | "after") => void;
  moveTabToIndex: (id: string, toIndex: number) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setActiveSideTab: (tab: SideTab) => void;
  toggleRightSidebar: () => void;
  setRightSidebarCollapsed: (collapsed: boolean) => void;
  /** Toggle the bottom-left floating MFA window. */
  toggleFloatingMfa: () => void;
  openFloatingMfa: () => void;
  closeFloatingMfa: () => void;
  /** Move the floating MFA window; coordinates are clamped to the viewport. */
  setFloatingMfaPosition: (left: number, bottom: number) => void;
  setFloatingMfaPinned: (pinned: boolean) => void;
  setFloatingMfaSearch: (query: string) => void;
  setMergeToolWindowRail: (value: boolean) => void;
  /** Apply the remembered sidebar state of the active tab's group (ED-PARITY-027). */
  applySidebarForActiveTab: () => void;
  /** Re-probe the local X server and update {@link xServerStatus}. */
  refreshXServer: () => Promise<void>;
  /** @deprecated X server availability is detected, not toggled. Kept as a
   *  manual re-probe trigger so the existing ribbon/menu command still works. */
  toggleXServer: () => void;
  setStatusMessage: (message: string) => void;
  toggleMultiExec: () => void;
  toggleMultiExecTab: (tabId: string) => void;
  selectAllTerminalTabs: () => void;
  clearMultiExecSelection: () => void;
  setTerminalSplitActive: (active: boolean) => void;
  toggleTerminalSplit: () => void;
  setTerminalSplitLayout: (layout: TerminalSplitLayout) => void;
  toggleTerminalSplitInputLock: (tabId: string) => void;
  clearTerminalSplitInputLocks: () => void;
  setTabHasNewOutput: (tabId: string, hasNewOutput: boolean) => void;
  setUiFontFamily: (font: string) => void;
  setUiFontSize: (size: number) => void;
  setVaultUnlockMode: (mode: VaultUnlockMode) => void;
  setWelcomeRecentSessionLimit: (limit: number) => void;
  upsertRecentWorkspace: (workspace: RecentWorkspace) => void;
  recordCodeWorkspaceTab: (tabId: string) => void;
  removeRecentWorkspace: (id: string) => void;
  clearRecentWorkspaces: () => void;
  setTabFilter: (filter: TabFilter | null) => void;
  clearTabFilter: () => void;
  /** Record a terminal tab's latest OSC-7 cwd (see {@link cwdByTab}). */
  setTabCwd: (tabId: string, cwd: string) => void;
  /** Merge live terminal connection/activity facts, or clear them with null. */
  setTerminalRuntime: (tabId: string, patch: Partial<TerminalRuntimeInfo> | null) => void;
  /**
   * Record (or clear, with `null`) a DB/Redis tab's live runtime connection id
   * (see {@link dbConnByTab}). Called by the DB client on connect/disconnect.
   */
  setTabDbConn: (tabId: string, connId: string | null) => void;
  /** Record or clear a DB tab's current schema-tree object selection. */
  setTabDbSelectedObjects: (tabId: string, selected: DbSelectedObject[] | null) => void;
  /** Record or clear a code workspace tab's current editor context. */
  setTabCodeWorkspaceContext: (tabId: string, context: CodeWorkspaceContext | null) => void;
  /** Toggle SQL echo to the linked query tab (see {@link sqlEcho}). */
  setSqlEcho: (enabled: boolean) => void;
}
