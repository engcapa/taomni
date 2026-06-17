import type { SshConnectInfo } from "../components/terminal/TerminalPanel";
import type { TerminalProfile } from "../lib/terminalProfile";
import type { NetworkSettingsPayload } from "../lib/networkSettings";
import type { RdpOptions } from "./rdp";
import type { ObjectStorageConfig } from "./objectStorage";

export type TabKind = "terminal" | "sftp" | "rdp" | "vnc" | "nettools" | "welcome" | "settings" | "placeholder" | "file-browser" | "database" | "redis" | "hbase-shell" | "proxy-test" | "object-storage";

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
  /** Per-session network settings (proxy / SSH jump host). The backend routes
   *  the connection through a loopback forwarder when this requests a proxy or
   *  jump host. Serialized as the same camelCase payload SSH uses. */
  networkSettings?: NetworkSettingsPayload | null;
}

/**
 * Connection parameters for the JVM-free HBase shell UI. The backend talks to
 * an HBase REST/Stargate-compatible endpoint directly.
 */
export interface HBaseConnectInfo {
  sessionId: string;
  workspaceSessionId?: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  ssl?: boolean;
  timeoutSecs?: number | null;
  restPath?: string | null;
  namespace?: string | null;
  /** "native" (RPC via ZooKeeper), "rest" (Stargate), or "thrift" (Lindorm 9190). */
  connectionMode?: "native" | "rest" | "thrift" | null;
  /** ZooKeeper quorum for native mode, e.g. "zk1:2181,zk2:2181". */
  zkQuorum?: string | null;
  /** ZooKeeper root znode for native mode (default "/hbase"). */
  zkRoot?: string | null;
  /** Effective user for native simple auth (default "root"). */
  effectiveUser?: string | null;
  /** Auth method for native mode: "simple" (default) or "kerberos". */
  authMethod?: "simple" | "kerberos" | null;
  /** Service principal for Kerberos auth, e.g. "hbase/host@REALM". */
  servicePrincipal?: string | null;
  /** Client principal for keytab-based Kerberos, e.g. "user@REALM". */
  principal?: string | null;
  /** Absolute path to a keytab file for automatic kinit. */
  keytabPath?: string | null;
  /** Absolute path to a custom krb5.conf file. */
  krb5ConfPath?: string | null;
  /** Absolute path to a custom hbase-site.xml file. */
  hbaseSitePath?: string | null;
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

export interface ProxyTestTabInfo {
  sessionId: string;
  proxyKind: "http" | "socks5";
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  testUrl?: string;
}

export interface FileBrowserTabInfo {
  initialPath: string;
}

/** Connection parameters for an object-storage browser tab (S3 / Azure Blob). */
export interface ObjectStorageTabInfo {
  sessionId: string;
  config: ObjectStorageConfig;
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
  hbase?: HBaseConnectInfo;
  fileBrowser?: FileBrowserTabInfo;
  proxyTest?: ProxyTestTabInfo;
  objectStorage?: ObjectStorageTabInfo;
  hasNewOutput?: boolean;
  /**
   * One-shot starting directory for a freshly opened local/SSH terminal tab.
   * Set when a terminal tab is duplicated so the copy lands in the same
   * working directory the source terminal was in (local terminals start the
   * shell there; SSH terminals `cd` there right after connecting). Consumed on
   * the initial connect and otherwise ignored.
   */
  terminalInitialCwd?: string;
}

/** A single local ↔ remote path mapping entry. */
export interface SftpPathMapping {
  localPath: string;
  remotePath: string;
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
  /** Deployment path mappings: local ↔ remote directory pairs. */
  pathMappings?: SftpPathMapping[];
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
