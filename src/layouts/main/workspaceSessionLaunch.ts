import type { SessionConfig } from "../../lib/ipc";
import { parseSessionOptions, getSessionTerminalProfile, loadTerminalDefaultProfile } from "../../lib/terminalProfile";
import { parsePathMappings } from "../../components/filebrowser/PathMappingsEditor";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";
import { parseVncViewerOptions } from "../../lib/vncOptions";
import { parseRdpOptions } from "../../types/rdp";
import { passwordRefFromOptions, resolveSessionAuth } from "./authentication";
import { sessionToDbConnectInfo, sessionToHBaseConnectInfo } from "./databaseSession";
import { commandTerminalFromSession, localShellSelectionFromSession } from "./sessionPolicy";
import type { WorkspaceSessionLaunch } from "../../stores/workspacePlatformStore";

/**
 * Build an isolated workspace session launch (v6.1 TASK-07) from a saved
 * global session. Mirrors the payload construction of the Sessions-mode tab
 * openers (useShellSessionTabs / useProtocolTabs) but targets the platform
 * workspace store — the resulting runtime never touches appStore.tabs.
 *
 * Credential-needing launches keep the same semantics as the global flow:
 * vault password references are passed through, and interactive password
 * entry defers to the pane's own auth prompt.
 */
export function buildWorkspaceSessionLaunch(session: SessionConfig): WorkspaceSessionLaunch {
  const launch: WorkspaceSessionLaunch = { session };
  const { method, data } = resolveSessionAuth(session);

  switch (session.session_type) {
    case "SSH": {
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
      break;
    }
    case "LocalShell": {
      launch.kind = "terminal";
      launch.title = session.name || "Local";
      launch.localShell = localShellSelectionFromSession(session);
      launch.terminalProfile = getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile();
      break;
    }
    case "Telnet":
    case "Serial":
    case "Mosh":
    case "Rlogin": {
      const commandTerminal = commandTerminalFromSession(session);
      if (commandTerminal) {
        launch.kind = "terminal";
        launch.title = session.name || commandTerminal.host;
        launch.commandTerminal = commandTerminal;
        launch.terminalProfile = getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile();
      }
      break;
    }
    case "SFTP": {
      launch.kind = "sftp";
      launch.title = `${session.name || `${session.username ?? "user"}@${session.host}`} (SFTP)`;
      const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
      const pathMappings = parsePathMappings(session.options_json);
      launch.sftp = {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username ?? "root",
        authMethod: method,
        authData: method === "Password" ? (passwordRefFromOptions(session) ?? data) : data,
        networkSettingsJson: JSON.stringify(ns),
        attachedToTerminal: false,
        pathMappings: pathMappings.length > 0 ? pathMappings : undefined,
      };
      break;
    }
    case "Redis":
    case "Database":
    case "MySQL":
    case "PostgreSQL":
    case "PanWeiDB":
    case "Oracle":
    case "SQLServer":
    case "StarRocks":
    case "ClickHouse":
    case "Presto": {
      const engine = session.session_type;
      const isRedis = engine === "Redis";
      launch.kind = isRedis ? "redis" : "database";
      const info = sessionToDbConnectInfo(session, method === "Password" ? (passwordRefFromOptions(session) ?? undefined) : (data ?? undefined));
      const prestoPath = info.engine === "Presto"
        ? [info.catalog, info.database].filter(Boolean).join(".")
        : info.database;
      launch.title = `${engine} ${session.host}:${session.port}${prestoPath ? `/${prestoPath}` : ""}`;
      launch.db = info;
      break;
    }
    case "HBase":
    case "HBaseShell": {
      launch.kind = "hbase-shell";
      launch.hbase = sessionToHBaseConnectInfo(session, method === "Password" ? (passwordRefFromOptions(session) ?? undefined) : (data ?? undefined));
      launch.title = session.name || `HBase ${session.host}:${session.port}`;
      break;
    }
    case "VNC": {
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
      break;
    }
    case "Rdp": {
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
      break;
    }
    default: {
      launch.kind = "terminal";
      launch.title = session.name || session.host || session.id;
      break;
    }
  }

  return launch;
}
