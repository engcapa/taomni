import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DbConnectInfo } from "../types";

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

function createBinaryOutputChannel(callback: (data: Uint8Array) => void): Channel<ArrayBuffer> {
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
}

export async function createLocalTerminal(
  sessionId: string,
  cols: number,
  rows: number,
  shell?: string,
  shellArgs?: string[],
  cwd?: string,
  onOutput?: (data: Uint8Array) => void,
): Promise<LocalTerminalCreated> {
  return invoke<LocalTerminalCreated>("create_local_terminal", {
    sessionId,
    cols,
    rows,
    shell,
    shellArgs,
    cwd,
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

export function encodeBase64(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// --- Session CRUD ---

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

export async function readPlistSessionFile(path: string): Promise<LocalSessionFile> {
  return invoke<LocalSessionFile>("read_plist_session_file", { path });
}

export async function exitApp(): Promise<void> {
  return invoke("exit_app", {});
}

export async function listSystemFonts(): Promise<string[]> {
  return invoke<string[]>("list_system_fonts", {});
}

export async function selectPrivateKeyFile(currentPath?: string): Promise<string | null> {
  return invoke<string | null>("select_private_key_file", { currentPath: currentPath ?? null });
}

export async function selectUploadFile(): Promise<string[]> {
  return invoke<string[]>("select_upload_file", {});
}

export async function selectSaveDirectory(currentPath?: string): Promise<string | null> {
  return invoke<string | null>("select_save_directory", { currentPath: currentPath ?? null });
}

export async function selectSaveFilePath(
  defaultName?: string,
  currentPath?: string,
): Promise<string | null> {
  return invoke<string | null>("select_save_file_path", {
    defaultName: defaultName ?? null,
    currentPath: currentPath ?? null,
  });
}

export async function selectFilePath(currentPath?: string): Promise<string | null> {
  return invoke<string | null>("select_file_path", { currentPath: currentPath ?? null });
}

export async function selectFolderPath(currentPath?: string): Promise<string | null> {
  return invoke<string | null>("select_folder_path", { currentPath: currentPath ?? null });
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path });
  return new Uint8Array(buffer);
}

export interface ReadStreamOpenResult {
  handleId: string;
  size: number;
  mtime: number;
}

export async function readStreamOpen(path: string): Promise<ReadStreamOpenResult> {
  return invoke<ReadStreamOpenResult>("read_stream_open", { path });
}

export async function readStreamRead(handleId: string, maxBytes = 64 * 1024): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_stream_read", { handleId, maxBytes });
  return new Uint8Array(buffer);
}

export async function readStreamClose(handleId: string): Promise<void> {
  return invoke("read_stream_close", { handleId });
}

export async function writeStreamOpen(path: string): Promise<string> {
  return invoke<string>("write_stream_open", { path });
}

export async function writeStreamAppend(handleId: string, data: Uint8Array): Promise<void> {
  return invoke("write_stream_append", data, {
    headers: { "x-handle-id": handleId },
  });
}

export async function writeStreamClose(handleId: string): Promise<void> {
  return invoke("write_stream_close", { handleId });
}

export async function writeStreamAbort(handleId: string): Promise<void> {
  return invoke("write_stream_abort", { handleId });
}

export async function checkFileExists(path: string): Promise<boolean> {
  return invoke<boolean>("check_file_exists", { path });
}

// --- Command history ────────────────────────────────────────────────

export async function historyAppend(
  hostKey: string,
  command: string,
  max: number,
): Promise<void> {
  return invoke("history_append", { hostKey, command, max });
}

export async function historyMatchPrefix(
  hostKey: string,
  prefix: string,
  limit: number,
): Promise<string[]> {
  return invoke<string[]>("history_match_prefix", { hostKey, prefix, limit });
}

export async function historyListRecent(
  hostKey: string,
  limit: number,
): Promise<string[]> {
  return invoke<string[]>("history_list_recent", { hostKey, limit });
}

export async function historyClear(hostKey: string | null): Promise<void> {
  return invoke("history_clear", { hostKey });
}

// --- VNC ────────────────────────────────────────────────────────────

export interface VncConnectResult {
  session_id: string;
  ws_port: number;
  width: number;
  height: number;
  name: string;
}

export async function vncConnect(
  host: string,
  port: number,
  username?: string | null,
  password?: string,
): Promise<VncConnectResult> {
  return withVaultLockedNotice(() =>
    invoke<VncConnectResult>("vnc_connect", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
    }),
  );
}

export async function vncDisconnect(sessionId: string): Promise<void> {
  return invoke("vnc_disconnect", { sessionId });
}

export async function vncTestConnection(
  host: string,
  port: number,
  username?: string | null,
  password?: string,
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke("vnc_test_connection", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
    }),
  );
}

// ---------- Vault ----------

export type VaultStateKind = "empty" | "locked" | "unlocked";

export interface VaultStatus {
  state: VaultStateKind;
  entry_count: number;
}

export interface VaultPutResult {
  id: string;
  reference: string;
}

export interface VaultEntrySummary {
  id: string;
  label: string;
  kind: string;
  created_at: number;
  updated_at: number;
}

export const VAULT_REF_PREFIX = "vault:";
export const VAULT_LOCKED_ERROR = "VAULT_LOCKED";
export const VAULT_LOCKED_EVENT = "vault-locked";

export function isVaultReference(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(VAULT_REF_PREFIX);
}

export function isVaultLockedError(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === "string" ? err : (err as Error).message ?? String(err);
  return msg.includes(VAULT_LOCKED_ERROR);
}

/**
 * Run an IPC call and, if it fails with VAULT_LOCKED, emit a global
 * `vault-locked` window event so MainLayout can surface the unlock dialog.
 * The error still propagates so callers can decide whether to retry after
 * the user unlocks (typically via a follow-up await of `whenUnlocked()`).
 */
export async function withVaultLockedNotice<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isVaultLockedError(e)) {
      window.dispatchEvent(new CustomEvent(VAULT_LOCKED_EVENT));
    }
    throw e;
  }
}

export async function vaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>("vault_status");
}

export async function vaultInit(masterPassword: string): Promise<void> {
  return invoke("vault_init", { masterPassword });
}

export async function vaultUnlock(masterPassword: string): Promise<void> {
  return invoke("vault_unlock", { masterPassword });
}

export async function vaultLock(): Promise<void> {
  return invoke("vault_lock");
}

export async function vaultChangeMaster(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  return invoke("vault_change_master", { oldPassword, newPassword });
}

export async function vaultPut(
  kind: string,
  label: string,
  plaintext: string,
): Promise<VaultPutResult> {
  return invoke<VaultPutResult>("vault_put", { kind, label, plaintext });
}

export async function vaultUpdate(id: string, plaintext: string): Promise<void> {
  return invoke("vault_update", { id, plaintext });
}

export async function vaultDelete(id: string): Promise<void> {
  return invoke("vault_delete", { id });
}

export async function vaultList(): Promise<VaultEntrySummary[]> {
  return invoke<VaultEntrySummary[]>("vault_list");
}

// --- Third-party importer secret recovery ---

export interface KeychainQuery {
  service: string;
  account: string;
}

export interface KeychainHit {
  service: string;
  account: string;
  found: boolean;
  value?: string;
  error?: string;
}

export async function keychainLookupBatch(
  entries: KeychainQuery[],
): Promise<KeychainHit[]> {
  return invoke<KeychainHit[]>("keychain_lookup_batch", { entries });
}

export type TabbySecret =
  | { kind: "password"; host: string; port?: number; user?: string; value: string }
  | { kind: "key-passphrase"; id: string; value: string };

export interface TabbyDecryptVaultResponse {
  secrets: TabbySecret[];
}

export const TABBY_VAULT_BAD_PASSWORD = "tabby_vault_bad_password";
export const TABBY_VAULT_MISSING = "tabby_vault_missing";

export function isTabbyBadPasswordError(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === "string" ? err : (err as Error).message ?? String(err);
  return msg.includes(TABBY_VAULT_BAD_PASSWORD);
}

export async function tabbyDecryptVault(
  yamlText: string,
  masterPassword: string,
): Promise<TabbyDecryptVaultResponse> {
  return invoke<TabbyDecryptVaultResponse>("tabby_decrypt_vault", {
    args: { yamlText, masterPassword },
  });
}

// --- Database client (MySQL / PostgreSQL / ClickHouse / Redis) ---

/** Strip the frontend-only `sessionId` to build the Rust `DbConfig` payload. */
function toDbConfigPayload(info: DbConnectInfo): Record<string, unknown> {
  return {
    engine: info.engine,
    host: info.host,
    port: info.port,
    username: info.username ?? null,
    password: info.password ?? null,
    database: info.database ?? null,
    ssl: info.ssl ?? false,
    timeoutSecs: info.timeoutSecs ?? null,
    httpPort: info.httpPort ?? null,
    protocol: info.protocol ?? null,
    dbIndex: info.dbIndex ?? null,
  };
}

export interface DbConnectResult {
  ok: boolean;
}

export async function dbConnect(info: DbConnectInfo): Promise<DbConnectResult> {
  return withVaultLockedNotice(() =>
    invoke<DbConnectResult>("db_connect", {
      sessionId: info.sessionId,
      config: toDbConfigPayload(info),
    }),
  );
}

export async function dbPing(sessionId: string): Promise<string> {
  return invoke<string>("db_ping", { sessionId });
}

/**
 * One-shot connection health check used by the "Test connection" button in the
 * session editor. Opens a throwaway connection, pings it, then disconnects so
 * no handle lingers in `AppState`.
 */
export async function dbTestConnection(info: DbConnectInfo): Promise<string> {
  const probeId = `db-test-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  const probe: DbConnectInfo = { ...info, sessionId: probeId };
  await dbConnect(probe);
  try {
    return await dbPing(probeId);
  } finally {
    await dbDisconnect(probeId).catch(() => undefined);
  }
}

export async function dbDisconnect(sessionId: string): Promise<void> {
  return invoke("db_disconnect", { sessionId });
}

export interface DbSchema {
  name: string;
}

export interface DbTable {
  name: string;
  kind: "table" | "view" | "materialized_view";
  rowCount?: number | null;
}

export interface DbColumnDescription {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
}

export interface DbIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface DbColumn {
  name: string;
  type: string;
}

export interface DbQueryResult {
  columns: DbColumn[];
  rows: (string | null)[][];
  rowsAffected: number;
  durationMs: number;
  warnings: string[];
}

export type DbQueryStreamEvent =
  | { kind: "columns"; columns: DbColumn[] }
  | { kind: "rows"; rows: (string | null)[][] }
  | { kind: "done"; rowsAffected: number; durationMs: number; warnings: string[] };

export async function dbListSchemas(sessionId: string): Promise<DbSchema[]> {
  return invoke<DbSchema[]>("db_list_schemas", { sessionId });
}

export async function dbListTables(
  sessionId: string,
  schema?: string | null,
): Promise<DbTable[]> {
  return invoke<DbTable[]>("db_list_tables", { sessionId, schema: schema ?? null });
}

export async function dbDescribeTable(
  sessionId: string,
  schema: string | null,
  table: string,
): Promise<DbColumnDescription[]> {
  return invoke<DbColumnDescription[]>("db_describe_table", {
    sessionId,
    schema: schema ?? null,
    table,
  });
}

export async function dbListIndexes(
  sessionId: string,
  schema: string | null,
  table: string,
): Promise<DbIndex[]> {
  return invoke<DbIndex[]>("db_list_indexes", {
    sessionId,
    schema: schema ?? null,
    table,
  });
}

export async function dbExecute(sessionId: string, sql: string): Promise<DbQueryResult> {
  return invoke<DbQueryResult>("db_execute", { sessionId, sql });
}

export async function dbExecuteStream(
  sessionId: string,
  sql: string,
  onEvent: (event: DbQueryStreamEvent) => void,
): Promise<void> {
  const channel = new Channel<DbQueryStreamEvent>();
  channel.onmessage = onEvent;
  return invoke("db_execute_stream", { sessionId, sql, onEvent: channel });
}

export async function dbCancel(sessionId: string): Promise<void> {
  return invoke("db_cancel", { sessionId });
}

// --- Redis ---

export interface RedisKeyEntry {
  key: string;
  type: "string" | "hash" | "list" | "set" | "zset" | "stream" | "none";
  /** TTL seconds: -1 persistent, -2 missing, else seconds remaining. */
  ttl: number;
}

export interface RedisScanPage {
  cursor: string;
  keys: RedisKeyEntry[];
}

export interface RedisValue {
  kind: "string" | "hash" | "list" | "set" | "zset" | "stream" | "none";
  /** Shape depends on kind — see Rust `RedisValue` doc. */
  value: unknown;
  ttl: number;
  encoding: string | null;
  memoryUsage: number | null;
}

export async function redisListKeys(
  sessionId: string,
  pattern: string,
  cursor: string,
  count: number,
): Promise<RedisScanPage> {
  return invoke<RedisScanPage>("redis_list_keys", {
    sessionId,
    pattern,
    cursor,
    count,
  });
}

export async function redisGetKey(sessionId: string, key: string): Promise<RedisValue> {
  return invoke<RedisValue>("redis_get_key", { sessionId, key });
}

export async function redisSetKey(
  sessionId: string,
  key: string,
  kind: string,
  value: unknown,
  ttl?: number | null,
): Promise<void> {
  return invoke("redis_set_key", { sessionId, key, kind, value, ttl: ttl ?? null });
}

export async function redisDelKey(sessionId: string, key: string): Promise<void> {
  return invoke("redis_del_key", { sessionId, key });
}

export async function redisExec(sessionId: string, rawCommand: string): Promise<string> {
  return invoke<string>("redis_exec", { sessionId, rawCommand });
}
