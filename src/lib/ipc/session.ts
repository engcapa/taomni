import { invoke } from "@tauri-apps/api/core";

// --- Session CRUD ---

// ---------------------------------------------------------------------------
// Welcome run snapshot (design §4.2, scheme B). Types mirror
// session/resume.rs; the richer contract lives in welcomeSessionResume.ts.
// ---------------------------------------------------------------------------

export interface IpcSnapshotEntrySavedSession {
  kind: "saved-session";
  identity: string;
  savedSessionId: string;
  savedSessionType: string;
  displayName: string;
}

export interface IpcSnapshotEntryLocalTerminal {
  kind: "local-terminal";
  identity: string;
  displayName: string;
  shellId: string;
  shellArgs: string[];
  confirmedCwd: string;
}

export type IpcSnapshotEntry = IpcSnapshotEntrySavedSession | IpcSnapshotEntryLocalTerminal;

export interface IpcRunSnapshotRecord {
  schemaVersion: number;
  revision: number;
  runSequence: number;
  batchId: string;
  committedAtMs: number;
  entries: IpcSnapshotEntry[];
  activeIdentity: string | null;
}

export interface IpcGetRunSnapshotResponse {
  record: IpcRunSnapshotRecord | null;
  legacyCandidate: IpcSnapshotEntry | null;
  issue: { code: string; message: string } | null;
}

export async function getWelcomeRunSnapshot(): Promise<IpcGetRunSnapshotResponse> {
  return invoke<IpcGetRunSnapshotResponse>("get_welcome_run_snapshot", {});
}

export async function commitWelcomeRunSnapshot(input: {
  batchId: string;
  entries: IpcSnapshotEntry[];
  activeIdentity: string | null;
  expectedRevision: number | null;
  restored: boolean;
}): Promise<{ record: IpcRunSnapshotRecord | null; applied: boolean }> {
  return invoke("commit_welcome_run_snapshot", input);
}

export async function clearWelcomeRunSnapshot(input: {
  expectedRevision: number | null;
}): Promise<void> {
  return invoke("clear_welcome_run_snapshot", {
    expectedRevision: input.expectedRevision,
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionConfig {
  id: string;
  name: string;
  session_type: string;
  group_path: string | null;
  host: string;
  port: number;
  username: string | null;
  auth_method: AuthMethod;
  options_json: string;
  created_at: number;
  updated_at: number;
  last_connected_at: number | null;
  sort_order: number;
}

export type AuthMethod =
  | "Password"
  | { PrivateKey: { key_path: string } }
  | "Agent"
  | "None";

export interface SessionGroup {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  icon: string | null;
}

export async function listSessions(
  group?: string,
): Promise<SessionConfig[]> {
  return invoke<SessionConfig[]>("list_sessions", { group: group ?? null });
}

export async function getSession(id: string): Promise<SessionConfig> {
  return invoke<SessionConfig>("get_session", { id });
}

export async function saveSession(config: SessionConfig): Promise<void> {
  return invoke("save_session", { config });
}

export async function deleteSession(id: string): Promise<void> {
  return invoke("delete_session", { id });
}

export async function markSessionConnected(id: string): Promise<number> {
  return invoke<number>("mark_session_connected", { id });
}

export async function listSessionGroups(): Promise<SessionGroup[]> {
  return invoke<SessionGroup[]>("list_session_groups", {});
}

export async function saveSessionGroup(group: SessionGroup): Promise<void> {
  return invoke("save_session_group", { group });
}

export async function deleteSessionGroup(id: string): Promise<void> {
  return invoke("delete_session_group", { id });
}

export interface LocalSessionFile {
  source: string;
  path: string;
  relativePath: string;
  text: string;
}

export interface DbeaverCredentialEntry {
  user?: string | null;
  password?: string | null;
  sections?: Record<string, Record<string, string>>;
}

export async function importPuttySessions(): Promise<SessionConfig[]> {
  return invoke<SessionConfig[]>("import_putty_sessions", {});
}

export async function importWslSessions(): Promise<SessionConfig[]> {
  return invoke<SessionConfig[]>("import_wsl_sessions", {});
}

export async function importExternalBashSessions(): Promise<SessionConfig[]> {
  return invoke<SessionConfig[]>("import_external_bash_sessions", {});
}

export async function scanLocalSessionFiles(source: string): Promise<LocalSessionFile[]> {
  return invoke<LocalSessionFile[]>("scan_local_session_files", { source });
}

export async function readDbeaverCredentialsForDataSources(
  path: string,
): Promise<Record<string, DbeaverCredentialEntry>> {
  return invoke<Record<string, DbeaverCredentialEntry>>("read_dbeaver_credentials_for_data_sources", { path });
}

export async function readPlistSessionFile(path: string): Promise<LocalSessionFile> {
  return invoke<LocalSessionFile>("read_plist_session_file", { path });
}
