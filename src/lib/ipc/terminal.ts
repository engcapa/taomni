import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { withVaultLockedNotice } from "./vault";

export interface LocalShellOption {
  id: string;
  name: string;
  path: string;
  args: string[];
  isDefault: boolean;
  canElevate: boolean;
}

export async function listLocalShells(): Promise<LocalShellOption[]> {
  return invoke<LocalShellOption[]>("list_local_shells", {});
}

export type DirectoryAvailability =
  | "unknown"
  | "available"
  | "missing"
  | "permission-denied"
  | "unavailable";

export type DirectoryTimeSource = "local-start" | "local-cwd";

export interface LocalDirectoryShortcut {
  label: string;
  path: string;
  kind: "system" | "personal";
  directoryId: string;
  lastUsedAtMs: number | null;
  timeSource: DirectoryTimeSource | null;
  legacyRank: number | null;
  defaultId: string | null;
  availability: DirectoryAvailability;
}

export interface DirectoryListEnvelope {
  revision: number;
  directories: LocalDirectoryShortcut[];
}

export function normalizeDirectoryShortcut(raw: unknown): LocalDirectoryShortcut | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const path = typeof item.path === "string" ? item.path : "";
  if (!path) return null;
  const kind = item.kind === "system" ? "system" : "personal";
  const timeSource: DirectoryTimeSource | null =
    item.timeSource === "local-start" || item.timeSource === "local-cwd"
      ? item.timeSource
      : null;
  return {
    label: typeof item.label === "string" ? item.label : path,
    path,
    kind,
    directoryId: typeof item.directoryId === "string" ? item.directoryId : "",
    lastUsedAtMs:
      typeof item.lastUsedAtMs === "number" && Number.isFinite(item.lastUsedAtMs)
        ? item.lastUsedAtMs
        : null,
    timeSource,
    legacyRank:
      typeof item.legacyRank === "number" && Number.isFinite(item.legacyRank)
        ? item.legacyRank
        : null,
    defaultId: typeof item.defaultId === "string" ? item.defaultId : null,
    availability: (["unknown", "available", "missing", "permission-denied", "unavailable"] as const).includes(
      item.availability as DirectoryAvailability,
    )
      ? (item.availability as DirectoryAvailability)
      : "unknown",
  };
}

/**
 * Reads the sorted directory listing. Accepts both the new envelope
 * `{revision, directories}` and the legacy bare array (older browser
 * fixtures), so stale consumers never misread an envelope as an empty list.
 */
export async function listCommonLocalDirectories(): Promise<{
  directories: LocalDirectoryShortcut[];
  revision: number;
}> {
  const raw = await invoke<unknown>("list_common_local_directories", {});
  if (Array.isArray(raw)) {
    return { directories: raw.map(normalizeDirectoryShortcut).filter((d): d is LocalDirectoryShortcut => d !== null), revision: 0 };
  }
  const envelope = raw as Partial<DirectoryListEnvelope> | null;
  const directories = Array.isArray(envelope?.directories) ? envelope!.directories : [];
  return {
    directories: directories
      .map(normalizeDirectoryShortcut)
      .filter((d): d is LocalDirectoryShortcut => d !== null),
    revision: typeof envelope?.revision === "number" ? envelope.revision : 0,
  };
}

/** Report a confirmed cwd change from a live native-local terminal. */
export async function recordLocalDirectoryUse(input: {
  backendSessionId: string;
  path: string;
}): Promise<{ changed: boolean }> {
  return invoke<{ changed: boolean }>("record_local_directory_use", {
    backendSessionId: input.backendSessionId,
    path: input.path,
  });
}

/** Emitted by the backend after a successful directory-usage transaction. */
export async function listenWelcomeDirectoriesChanged(
  callback: (revision: number) => void,
): Promise<UnlistenFn> {
  return listen<{ revision: number }>("welcome-directories-changed", (event) => {
    callback(typeof event.payload?.revision === "number" ? event.payload.revision : 0);
  });
}

export async function openLocalShellAsAdministrator(shell?: string): Promise<void> {
  return invoke("open_local_shell_as_administrator", { shell });
}

export interface WslDistro {
  name: string;
  isDefault: boolean;
  state: string;
  version: number | null;
}

export async function listWslDistros(): Promise<WslDistro[]> {
  return invoke<WslDistro[]>("list_wsl_distros", {});
}

export function createTerminalSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `term-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createBinaryOutputChannel(callback: (data: Uint8Array) => void): Channel<ArrayBuffer> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (message) => {
    callback(new Uint8Array(message));
  };
  return channel;
}

export interface LocalTerminalCreated {
  sessionId: string;
  /** `LocalShellOption.id` of the shell the backend actually launched. */
  shellId: string;
  /** SDK variables that task wrappers must restore after shell profile setup. */
  taskEnvironment: Record<string, string>;
  /**
   * Present when the terminal started but the local-directory usage record
   * could not be saved. Never turns a successful launch into a failure.
   */
  directoryUseWarning?: string | null;
}

export async function createLocalTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  shell?: string,
  shellArgs?: string[],
  cwd?: string,
  onOutput?: (data: Uint8Array) => void,
  workspaceRoot?: string,
): Promise<LocalTerminalCreated> {
  return invoke<LocalTerminalCreated>("create_local_terminal", {
    sessionId,
    cols,
    rows,
    shell,
    shellArgs,
    cwd,
    workspaceRoot,
    onOutput: createBinaryOutputChannel(onOutput ?? (() => undefined)),
  });
}

export async function createCommandTerminal(
  sessionId: string,
  kind: string,
  host: string,
  port: number,
  username: string | null | undefined,
  optionsJson: string | null | undefined,
  cols: number,
  rows: number,
  onOutput?: (data: Uint8Array) => void,
): Promise<string> {
  return invoke<string>("create_command_terminal", {
    sessionId,
    kind,
    host,
    port,
    username,
    optionsJson,
    cols,
    rows,
    onOutput: createBinaryOutputChannel(onOutput ?? (() => undefined)),
  });
}

export async function createSshTerminal(
  sessionId: string,
  host: string,
  port: number,
  username: string,
  authMethod: string,
  authData: string | null,
  cols: number,
  rows: number,
  networkSettingsJson: string | null = null,
  onOutput?: (data: Uint8Array) => void,
  x11: boolean = false,
  x11Trusted: boolean = true,
  startupCommand: string | null = null,
  keepOpenAfterStartupCommand: boolean = false,
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke<string>("create_ssh_terminal", {
      sessionId,
      host,
      port,
      username,
      authMethod,
      authData,
      cols,
      rows,
      networkSettingsJson,
      x11,
      x11Trusted,
      startupCommand,
      keepOpenAfterStartupCommand,
      onOutput: createBinaryOutputChannel(onOutput ?? (() => undefined)),
    }),
  );
}

/** Local system X server (Xorg / XQuartz / VcXsrv / WSLg) detection result. */
export interface XServerStatus {
  available: boolean;
  display: string;
  endpoint: string;
  hasCookie: boolean;
  provider: string;
  hint: string | null;
}

/**
 * Probe the local X server so the UI can show honest X11 status and prompt to
 * install XQuartz/VcXsrv when none is reachable. Returns a safe "unavailable"
 * status if the backend command is missing (e.g. web preview stub).
 */
export async function detectXServer(): Promise<XServerStatus> {
  try {
    const raw = await invoke<{
      available: boolean;
      display: string;
      endpoint: string;
      has_cookie: boolean;
      provider: string;
      hint: string | null;
    }>("detect_x_server");
    return {
      available: raw.available,
      display: raw.display,
      endpoint: raw.endpoint,
      hasCookie: raw.has_cookie,
      provider: raw.provider,
      hint: raw.hint,
    };
  } catch {
    return {
      available: false,
      display: "",
      endpoint: "",
      hasCookie: false,
      provider: "unknown",
      hint: "no-display",
    };
  }
}

/** A single prompt within a keyboard-interactive (MFA/OTP) auth round. */
export interface SshAuthPromptEntry {
  prompt: string;
  /** When false the answer is secret (password/OTP) and should be masked. */
  echo: boolean;
}

/** Payload of the `ssh-auth-prompt-{sessionId}` event. */
export interface SshAuthPromptPayload {
  requestId: string;
  name: string;
  instructions: string;
  prompts: SshAuthPromptEntry[];
}

/**
 * Listen for keyboard-interactive auth prompts (MFA/OTP) emitted by the
 * backend mid-connect for `sessionId`. The callback receives the server's
 * prompts; answer them via {@link submitSshAuthResponse} using the same
 * `requestId`.
 */
export async function listenSshAuthPrompt(
  sessionId: string,
  callback: (payload: SshAuthPromptPayload) => void,
): Promise<UnlistenFn> {
  return listen<SshAuthPromptPayload>(`ssh-auth-prompt-${sessionId}`, (event) => {
    callback(event.payload);
  });
}

/**
 * Deliver the user's answers to a pending keyboard-interactive auth round.
 * Pass `null` for `responses` to cancel the prompt (aborts the connection).
 */
export async function submitSshAuthResponse(
  requestId: string,
  responses: string[] | null,
): Promise<void> {
  return invoke("submit_ssh_auth_response", { requestId, responses });
}

export async function attachTerminalOutput(
  sessionId: string,
  onOutput?: (data: Uint8Array) => void,
): Promise<void> {
  return invoke("attach_terminal_output", {
    sessionId,
    onOutput: createBinaryOutputChannel(onOutput ?? (() => undefined)),
  });
}

export async function testSshConnection(
  host: string,
  port: number,
  username: string,
  authMethod: string,
  authData: string | null,
  networkSettingsJson: string | null = null,
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke<string>("test_ssh_connection", {
      host,
      port,
      username,
      authMethod,
      authData,
      networkSettingsJson,
    }),
  );
}

export async function writeTerminal(
  sessionId: string,
  data: string,
): Promise<void> {
  return invoke("write_terminal", { sessionId, data });
}

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("resize_terminal", { sessionId, cols, rows });
}

export async function sendTerminalSignal(
  sessionId: string,
  signal: string,
): Promise<void> {
  return invoke("send_terminal_signal", { sessionId, signal });
}

export async function closeTerminal(sessionId: string): Promise<void> {
  return invoke("close_terminal", { sessionId });
}

/**
 * Tell the backend that a terminal *tab* (`tabId` — the id CC's tools see, equal
 * to a chat thread's `linked_session_id`) is backed by a concrete backend
 * terminal session (`sessionId`, the `state.terminals` key). This lets
 * backend-side Claude Code tools (`run_captured` / `read_capture`) resolve the
 * live terminal that `run_in_terminal` reaches indirectly via the frontend
 * registry. Called as a terminal connects; safe to call repeatedly.
 */
export async function ccTrackTerminal(tabId: string, sessionId: string): Promise<void> {
  return invoke("cc_track_terminal", { tabId, sessionId });
}

/** Drop a tab → backend-session mapping recorded by {@link ccTrackTerminal}. */
export async function ccUntrackTerminal(tabId: string, sessionId: string): Promise<void> {
  return invoke("cc_untrack_terminal", { tabId, sessionId });
}

export async function listenTerminalExit(
  sessionId: string,
  callback: () => void,
): Promise<UnlistenFn> {
  return listen(`terminal-exit-${sessionId}`, () => {
    callback();
  });
}

export interface ForwardErrorPayload {
  local: string;
  remote: string;
  message: string;
}

export async function listenTerminalForwardError(
  sessionId: string,
  callback: (err: ForwardErrorPayload) => void,
): Promise<UnlistenFn> {
  return listen<ForwardErrorPayload>(
    `terminal-forward-error-${sessionId}`,
    (event) => {
      callback(event.payload);
    },
  );
}
