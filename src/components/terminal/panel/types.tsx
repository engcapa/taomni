import { type TerminalProfile } from "../../../lib/terminalProfile";
import type { SocksCapTerminalLaunchInfo } from "../../../types";


export interface SshConnectInfo {
  /** Persisted session config id, if this terminal was opened from a
   *  saved session. Used so the SessionEditor can subscribe to runtime
   *  forward errors for the session it is editing. */
  sessionId?: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  optionsJson?: string;
}


export interface CommandTerminalConnectInfo {
  sessionId?: string;
  kind: "FTP" | "Telnet" | "Rlogin" | "Serial" | "Mosh";
  host: string;
  port: number;
  username?: string | null;
  optionsJson?: string | null;
}


export interface TerminalReattachState {
  terminalSessionId?: string;
  snapshotText?: string;
}


export interface AdoptedTerminalSession {
  sessionId: string;
  snapshotText?: string;
}


export interface DetachedTerminalWindowControls {
  onReattach: (state?: TerminalReattachState) => void;
  onToggleOsFullscreen: () => void;
  osFullscreen: boolean;
}


export interface TerminalLocalPathUploadRequest {
  paths: string[];
  cwd: string | null;
}


export interface TerminalPanelProps {
  tabId?: string;
  tabTitle?: string;
  theme?: string;
  ssh?: SshConnectInfo;
  commandTerminal?: CommandTerminalConnectInfo;
  localShell?: {
    id: string;
    name: string;
    args?: string[];
  };
  terminalProfile?: TerminalProfile;
  onTerminalProfileChange?: (profile: TerminalProfile) => void;
  adoptedTerminal?: AdoptedTerminalSession;
  sockscapTerminal?: SocksCapTerminalLaunchInfo;
  /**
   * One-shot working directory for the initial connect. Local terminals launch
   * the shell here; SSH terminals `cd` here right after the shell opens. Used
   * when a terminal tab is duplicated so the copy lands in the source's cwd.
   */
  initialCwd?: string;
  /** Enables backend-owned SDK environment injection for workspace terminals. */
  workspaceRoot?: string;
  preserveSessionOnUnmount?: boolean;
  detachedWindowControls?: DetachedTerminalWindowControls;
  onDetachedStateChange?: (state: TerminalReattachState) => void;
  visible?: boolean;
  activeForShortcuts?: boolean;
  inputLocked?: boolean;
  onCwdChange?: (cwd: string) => void;
  /** Incremented by the parent when the SFTP panel explicitly asks for cwd. */
  cwdRequestToken?: number;
  /** Called once the backend terminal session ID is known (after connect). */
  onSessionReady?: (sessionId: string) => void;
  /**
   * Structured launch failure notification (design §4.1.5): called from
   * `handleConnectFailure` so the parent can complete a pending local-launch
   * request. Existing in-panel failure handling is unchanged.
   */
  onSessionLaunchFailed?: (error: unknown) => void;
  /** Called whenever the terminal receives output (for new-output badge). */
  onOutput?: () => void;
  /** Workspace task terminals report their shell exit marker through OSC 633. */
  onTaskExit?: (exitCode: number) => void;
  /** SSH-only: upload local OS file paths into the terminal's current remote cwd. */
  onUploadLocalPaths?: (request: TerminalLocalPathUploadRequest) => Promise<void> | void;
  /** Whether MultiExec broadcast mode is active globally. */
  multiExecActive?: boolean;
  /** Whether this terminal is a selected broadcast target (shows visual indicator). */
  isMultiExecTarget?: boolean;
  /** Called with user input when MultiExec is active; parent broadcasts to other terminals. */
  onInputBroadcast?: (data: string) => void;
  /** When set, the floating toolbar shows an SFTP toggle button. Only used
   *  for SSH terminals where the parent owns the attached SFTP sidebar. */
  sftpToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  /** Floating-toolbar button for the AI chat thread bound to this tab. */
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  /** Local-terminal Git entry for the current working directory. */
  gitToggle?: {
    cwd: string | null;
    onOpen: () => void;
  };
  /** When set, the floating toolbar exposes a "Detach to its own window"
   *  button that calls back into MainLayout. Hidden in detached windows
   *  themselves (which already live in their own OS window). */
  detachToggle?: {
    onDetach: () => void;
  };
}


export interface SearchMatch {
  row: number;
  col: number;
  length: number;
}


export interface KeywordHighlight extends SearchMatch {
  kind: "error" | "warning" | "success";
}


export interface TerminalBlockSelectionCell {
  row: number;
  col: number;
}


export interface TerminalBlockSelection {
  anchor: TerminalBlockSelectionCell;
  focus: TerminalBlockSelectionCell;
}


export interface TerminalEventLogEntry {
  id: number;
  time: string;
  type: string;
  detail: string;
}


export type TerminalConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "reconnecting";

export type TerminalGitState =
  | { kind: "unknown"; label: string; title: string }
  | { kind: "repo"; label: string; title: string; repoRoot: string }
  | { kind: "none"; label: string; title: string }
  | { kind: "error"; label: string; title: string };
