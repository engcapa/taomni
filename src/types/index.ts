import type { SshConnectInfo } from "../components/terminal/TerminalPanel";
import type { TerminalProfile } from "../lib/terminalProfile";
import type { RdpOptions } from "./rdp";

export type TabKind = "terminal" | "sftp" | "rdp" | "vnc" | "nettools" | "welcome" | "settings" | "placeholder" | "file-browser" | "database" | "redis";

export interface VncConnectInfo {
  sessionId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
}

/**
 * Connection parameters for a database client tab (MySQL / PostgreSQL /
 * ClickHouse / Presto / Redis). Mirrors the Rust `DbConfig` (camelCase). The password
 * may be a `vault:<id>` reference resolved server-side.
 */
export interface DbConnectInfo {
  sessionId: string;
  /** Stable saved-session id used for restoring query workspace files. */
  workspaceSessionId?: string;
  engine: "MySQL" | "PostgreSQL" | "ClickHouse" | "Presto" | "Redis";
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  /** Presto catalog name. */
  catalog?: string | null;
  database?: string | null;
  ssl?: boolean;
  timeoutSecs?: number | null;
  /** ClickHouse HTTP port (defaults to 8123). */
  httpPort?: number | null;
  /** ClickHouse protocol: "http" (default) or "native". */
  protocol?: string | null;
  /** Redis logical DB index (0-15). */
  dbIndex?: number | null;
}

export interface RdpConnectInfo {
  sessionId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  options: RdpOptions;
  /** JSON blob mirroring the SSH `networkSettings` shape; null = direct. */
  networkSettingsJson?: string | null;
}

export interface FileBrowserTabInfo {
  initialPath: string;
}

export interface Tab {
  id: string;
  type: TabKind;
  title: string;
  sessionId?: string;
  connectionId?: string;
  closable: boolean;
  ssh?: SshConnectInfo;
  localShell?: LocalShellSelection;
  adoptedTerminal?: AdoptedTerminalInfo;
  terminalProfile?: TerminalProfile;
  message?: string;
  sftp?: SftpTabInfo;
  vnc?: VncConnectInfo;
  rdp?: RdpConnectInfo;
  db?: DbConnectInfo;
  fileBrowser?: FileBrowserTabInfo;
  hasNewOutput?: boolean;
}

export interface SftpTabInfo {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  networkSettingsJson?: string | null;
  initialPath?: string;
  attachedToTerminal?: boolean;
}

export interface LocalShellSelection {
  id: string;
  name: string;
  args?: string[];
}

export interface AdoptedTerminalInfo {
  sessionId: string;
  snapshotText?: string;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
