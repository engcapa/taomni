import { type SessionConfig } from "../../lib/ipc";
import type { LocalLaunchOutcome, LocalShellSelection, RecentWorkspace } from "../../types";
import type { EntryOutcome, RestoreViewState } from "../../hooks/useWelcomeSessionResume";


export interface WelcomeRestoreProp {
  view: RestoreViewState;
  outcomes: EntryOutcome[];
  onStartRestore: () => void;
  onRetryFailed: () => void;
  onCancelRestore: () => void;
  onClearRecord: () => void;
}


export interface WelcomePanelProps {
  /**
   * One-click restore entry for the last run's session tab set (design
   * §4.2.4). Omitted in tests that don't exercise restore.
   */
  restore?: WelcomeRestoreProp;
  /**
   * Starts a local terminal. Returns the structured launch outcome (design
   * §4.1.5); may resolve `undefined` for legacy synchronous callers.
   */
  onStartLocalTerminal: (
    shell?: LocalShellSelection,
    cwd?: string,
  ) => Promise<LocalLaunchOutcome | void> | void;
  onNewSession: () => void;
  onOpenLocalPath?: (path: string, opts?: { embedFolder?: boolean; }) => void;
  onOpenLanChat?: () => void;
  recentSessions?: SessionConfig[];
  recentWorkspaces?: RecentWorkspace[];
  mailSessions?: SessionConfig[];
  onOpenMailSession?: (session: SessionConfig) => void;
  onOpenRecentSession?: (session: SessionConfig) => void;
  onOpenRecentSessions?: (sessions: SessionConfig[]) => void;
  onEditRecentSession?: (session: SessionConfig) => void;
  onRevealRecentSession?: (session: SessionConfig) => void;
  onOpenRecentWorkspace?: (workspace: RecentWorkspace) => void;
  onRemoveRecentWorkspace?: (workspace: RecentWorkspace) => void;
  onClearRecentWorkspaces?: () => void;
  onRevealRecentWorkspace?: (workspace: RecentWorkspace) => void;
  onOpenNewWorkspace?: () => void;
  onOpenSettings?: () => void;
  /**
   * Whether the Welcome tab is currently visible. The panel stays mounted so
   * shell/filter state survives tab switches; when it becomes active we
   * refresh recent local directories from command history / shell cwd.
   */
  active?: boolean;
}

export type RecentSessionSort =
  | "last-desc"
  | "last-asc"
  | "name-asc"
  | "name-desc"
  | "type-asc"
  | "type-desc"
  | "host-asc"
  | "host-desc";

export type WelcomeHistoryTab = "directories" | "workspaces" | "sessions";
