import type { DbeaverCredentialEntry, SessionConfig } from "../ipc";


export const TAOMNI_FORMAT = "taomni.sessions";

// Legacy export-format tag (app was renamed NewMob → Taomni). Still accepted
// on import so files exported by older builds keep working.
export const LEGACY_FORMAT = "newmob.sessions";

export const SCHEMA_VERSION = 1;

export const MAX_IMPORT_CHARS = 2_000_000;

// ZeroOmega/SwitchyOmega backups embed full AutoSwitch rule lists and PAC
// scripts, so a single options export routinely runs to several MB even though
// only the tiny FixedProfile entries are imported. Allow a much larger cap for
// that format while keeping the conservative default for everything else.
export const MAX_ZEROOMEGA_IMPORT_CHARS = 32_000_000;

export const MAX_SESSIONS = 5_000;

export const MAX_NAME_LENGTH = 160;

export const MAX_HOST_LENGTH = 512;

export const MAX_PATH_LENGTH = 1_024;

export const MAX_OPTION_LENGTH = 4_000;


export const DEFAULT_PORTS: Record<string, number> = {
  SSH: 22,
  Telnet: 23,
  Rlogin: 513,
  RDP: 3389,
  VNC: 5900,
  FTP: 21,
  SFTP: 22,
  Serial: 0,
  LocalShell: 0,
  File: 0,
  Browser: 0,
  Mosh: 60001,
  MySQL: 3306,
  PostgreSQL: 5432,
  PanWeiDB: 5432,
  Oracle: 1521,
  SQLServer: 1433,
  StarRocks: 9030,
  ClickHouse: 9000,
  Presto: 8080,
  Redis: 6379,
  HBaseShell: 8080,
  Proxy: 3128,
  Mail: 993,
};


export interface SessionImportOptions {
  targetFolder?: string | null;
  existingSessions?: readonly SessionConfig[];
  now?: number;
  sourcePath?: string | null;
  homeDir?: string | null;
  includeSecrets?: boolean;
  dbeaverCredentials?: Record<string, DbeaverCredentialEntry | null | undefined>;
}


export interface SessionImportSecret {
  sessionId: string;
  kind: "password" | "key-passphrase";
  label: string;
  value: string;
  /**
   * `"session"` (default) attaches to the parent session via `passwordRef`;
   * `"standalone"` writes a plain vault entry the user manages by hand
   * (used for Tabby private-key passphrases that don't map to a Taomni
   * private-key path).
   */
  attachment?: "session" | "standalone";
}


export interface ExternalVaultPrompt {
  /** Tool name, e.g. "Tabby". Drives dialog title. */
  tool: string;
  /** Original config text (passed back to the per-tool decryptor). */
  rawText: string;
  /** Body copy shown above the password field. */
  description: string;
}


export interface SecureCrtEncryptedPassword {
  sessionId: string;
  label: string;
  encrypted: string;
}


export interface SessionImportResult {
  sessions: SessionConfig[];
  warnings: string[];
  skipped: number;
  secrets: SessionImportSecret[];
  secureCrtPasswords?: SecureCrtEncryptedPassword[];
  /**
   * Set when the imported config carries an encrypted secret blob the user
   * must unlock with the source tool's master password. The orchestrator
   * (SessionTree) drives the unlock + decrypt flow.
   */
  externalVault?: ExternalVaultPrompt;
  /**
   * Set on results whose sessions may have remembered passwords stored in
   * the source tool's OS keychain entries (Credential Manager / Keychain /
   * Secret Service). The orchestrator runs `keychainLookupBatch` for the
   * tool's naming convention. Independent of `externalVault` because some
   * Tabby installs use only the keychain, with no encrypted vault block.
   */
  externalSecretsTool?: "tabby" | "securecrt";
}


export interface SessionExportResult {
  filename: string;
  text: string;
  mimeType: string;
  warnings: string[];
  skipped: number;
}


export interface PortableSession {
  name: string;
  type: string;
  folder_path: string | null;
  host: string;
  port: number;
  username: string | null;
  auth: PortableAuth;
  options: Record<string, unknown>;
  sort_order: number;
}


export type PortableAuth =
  | { kind: "password" }
  | { kind: "private-key"; private_key_path: string }
  | { kind: "agent" }
  | { kind: "none" };
