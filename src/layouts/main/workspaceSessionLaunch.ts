import type { SessionConfig } from "../../lib/ipc";
import { parseSessionOptions, getSessionTerminalProfile, loadTerminalDefaultProfile } from "../../lib/terminalProfile";
import { parsePathMappings } from "../../components/filebrowser/PathMappingsEditor";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";
import { parseVncViewerOptions } from "../../lib/vncOptions";
import { parseRdpOptions } from "../../types/rdp";
import { passwordRefFromOptions, resolveSessionAuth } from "./authentication";
import { sessionToDbConnectInfo, sessionToHBaseConnectInfo } from "./databaseSession";
import { COMMAND_TERMINAL_SESSION_TYPES, commandTerminalFromSession, localShellSelectionFromSession } from "./sessionPolicy";
import type { WorkspaceSessionLaunch } from "../../stores/workspacePlatformStore";

/** Database engines share the database pane (v6.1 TASK-07). */
const DB_SESSION_TYPES = new Set([
  "Database",
  "MySQL",
  "PostgreSQL",
  "PanWeiDB",
  "Oracle",
  "SQLServer",
  "StarRocks",
  "ClickHouse",
  "Presto",
  "Redis",
]);

/**
 * Build an isolated workspace session launch (v6.1 TASK-07) from a saved
 * global session. Mirrors the payload construction of the Sessions-mode tab
 * openers (useShellSessionTabs / useProtocolTabs) but targets the platform
 * workspace store — the resulting runtime never touches appStore.tabs.
 *
 * The dispatch table uses the canonical `session_type` spellings from
 * `connectionQueue.ts` (v6.1 review H5): a wrong casing used to fall through
 * to a default branch and silently open a local shell instead of the protocol
 * the user picked.
 *
 * Credential-needing launches keep the same semantics as the global flow:
 * vault password references are passed through, and interactive password
 * entry defers to the pane's own auth prompt.
 */
export function buildWorkspaceSessionLaunch(session: SessionConfig): WorkspaceSessionLaunch {
  const launch: WorkspaceSessionLaunch = { session };
  const { method, data } = resolveSessionAuth(session);

  if (session.session_type === "SSH") {
    launch.kind = "terminal";
    launch.title = session.name || `${session.username}@${session.host}`;
    launch.ssh = {
      sessionId: session.id,
      host: session.host,
      port: session.port,
      username: session.username ?? "root",
      authMethod: method,
      authData: method === "Password" ? (passwordRefFromOptions(session) ?? data) : data,
      optionsJson: session.options_json,
    };
    launch.terminalProfile = getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile();
    return launch;
  }

  if (session.session_type === "LocalShell") {
    launch.kind = "terminal";
    launch.title = session.name || "Local";
    launch.localShell = localShellSelectionFromSession(session);
    launch.terminalProfile = getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile();
    return launch;
  }

  if (COMMAND_TERMINAL_SESSION_TYPES.has(session.session_type)) {
    const commandTerminal = commandTerminalFromSession(session);
    if (!commandTerminal) {
      launch.unsupported = session.session_type;
      return launch;
    }
    launch.kind = "terminal";
    launch.title = session.name || commandTerminal.host;
    launch.commandTerminal = commandTerminal;
    launch.terminalProfile = getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile();
    return launch;
  }

  if (session.session_type === "SFTP") {
    launch.kind = "sftp";
    launch.title = `${session.name || `${session.username ?? "user"}@${session.host}`} (SFTP)`;
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    const pathMappings = parsePathMappings(session.options_json);
    // A workspace tab owns a unique SFTP runtime: keying the pane by the saved
    // session id made two workspace instances share one attachment (review M3).
    launch.sftp = {
      sessionId: `ws-sftp-${session.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      host: session.host,
      port: session.port,
      username: session.username ?? "root",
      authMethod: method,
      authData: method === "Password" ? (passwordRefFromOptions(session) ?? data) : data,
      networkSettingsJson: JSON.stringify(ns),
      attachedToTerminal: false,
      pathMappings: pathMappings.length > 0 ? pathMappings : undefined,
    };
    return launch;
  }

  if (DB_SESSION_TYPES.has(session.session_type)) {
    const engine = session.session_type;
    const isRedis = engine === "Redis";
    launch.kind = isRedis ? "redis" : "database";
    const info = sessionToDbConnectInfo(session, method === "Password" ? (passwordRefFromOptions(session) ?? undefined) : (data ?? undefined));
    const prestoPath = info.engine === "Presto"
      ? [info.catalog, info.database].filter(Boolean).join(".")
      : info.database;
    launch.title = `${engine} ${session.host}:${session.port}${prestoPath ? `/${prestoPath}` : ""}`;
    launch.db = info;
    return launch;
  }

  if (session.session_type === "HBaseShell" || session.session_type === "HBase") {
    launch.kind = "hbase-shell";
    launch.hbase = sessionToHBaseConnectInfo(session, method === "Password" ? (passwordRefFromOptions(session) ?? undefined) : (data ?? undefined));
    launch.title = session.name || `HBase ${session.host}:${session.port}`;
    return launch;
  }

  if (session.session_type === "VNC") {
    launch.kind = "vnc";
    launch.title = session.name || `${session.host}:${session.port}`;
    const options = parseSessionOptions(session.options_json);
    const rawPolicy = typeof options.vncSecurityPolicy === "string" ? options.vncSecurityPolicy : "prefer-encryption";
    const securityPolicy = ["require-encryption", "legacy-compatible", "allow-none", "prefer-off"].includes(rawPolicy)
      ? rawPolicy
      : "prefer-encryption";
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    launch.vnc = {
      sessionId: session.id,
      host: session.host,
      port: session.port,
      username: session.username,
      password: method === "Password" ? (passwordRefFromOptions(session) ?? data ?? undefined) : (data ?? undefined),
      networkSettingsJson: JSON.stringify(ns),
      securityPolicy: securityPolicy as never,
      viewOnly: options.vncViewOnly === true,
      clipboardPolicy: ["disabled", "client-to-server", "server-to-client"].includes(String(options.vncClipboardPolicy))
        ? options.vncClipboardPolicy as never
        : "bidirectional",
      viewerOptions: parseVncViewerOptions(options),
    };
    return launch;
  }

  if (session.session_type === "RDP" || session.session_type === "Rdp") {
    launch.kind = "rdp";
    launch.title = session.name || `${session.host}:${session.port}`;
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    launch.rdp = {
      sessionId: session.id,
      host: session.host,
      port: session.port,
      username: session.username,
      password: method === "Password" ? (passwordRefFromOptions(session) ?? data ?? undefined) : (data ?? undefined),
      options: parseRdpOptions(session.options_json),
      networkSettingsJson: JSON.stringify(ns),
    };
    return launch;
  }

  // File / Browser / Mail / S3 / Proxy sessions have no isolated workspace pane
  // yet. Report it instead of opening a local shell (v6.1 review H5).
  launch.unsupported = session.session_type;
  launch.title = session.name || session.host || session.id;
  return launch;
}
