import type { AuthMethod, SessionConfig } from "./ipc";
import {
  groupPathContains,
  leafGroupName,
  normalizeGroupPath,
  toStoredGroupPath,
} from "./sessionPaths";
import { normalizeTerminalProfile, parseSessionOptions } from "./terminalProfile";

const TAOMNI_FORMAT = "taomni.sessions";
// Legacy export-format tag (app was renamed NewMob → Taomni). Still accepted
// on import so files exported by older builds keep working.
const LEGACY_FORMAT = "newmob.sessions";
const SCHEMA_VERSION = 1;
const MAX_IMPORT_CHARS = 2_000_000;
// ZeroOmega/SwitchyOmega backups embed full AutoSwitch rule lists and PAC
// scripts, so a single options export routinely runs to several MB even though
// only the tiny FixedProfile entries are imported. Allow a much larger cap for
// that format while keeping the conservative default for everything else.
const MAX_ZEROOMEGA_IMPORT_CHARS = 32_000_000;
const MAX_IMPORT_ARCHIVE_BYTES = 50_000_000;
const MAX_SESSIONS = 5_000;
const MAX_NAME_LENGTH = 160;
const MAX_HOST_LENGTH = 512;
const MAX_PATH_LENGTH = 1_024;
const MAX_OPTION_LENGTH = 4_000;

const DEFAULT_PORTS: Record<string, number> = {
  SSH: 22,
  Telnet: 23,
  RDP: 3389,
  VNC: 5900,
  FTP: 21,
  SFTP: 22,
  Serial: 0,
  LocalShell: 0,
  File: 0,
  MySQL: 3306,
  PostgreSQL: 5432,
  ClickHouse: 9000,
  Presto: 8080,
  Redis: 6379,
  HBaseShell: 8080,
  Proxy: 3128,
};

const MOBAXTERM_TYPE_TO_SESSION: Record<string, string> = {
  "0": "SSH",
  "4": "RDP",
  "5": "VNC",
  "7": "SFTP",
};

const MOBAXTERM_EXPORT_TYPES: Record<string, { code: string; icon: string }> = {
  SSH: { code: "0", icon: "109" },
  RDP: { code: "4", icon: "91" },
  VNC: { code: "5", icon: "128" },
  SFTP: { code: "7", icon: "140" },
};

export interface SessionImportOptions {
  targetFolder?: string | null;
  existingSessions?: readonly SessionConfig[];
  now?: number;
  sourcePath?: string | null;
  homeDir?: string | null;
  includeSecrets?: boolean;
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

export interface SessionImportResult {
  sessions: SessionConfig[];
  warnings: string[];
  skipped: number;
  secrets: SessionImportSecret[];
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
  externalSecretsTool?: "tabby";
}

export interface SessionExportResult {
  filename: string;
  text: string;
  mimeType: string;
  warnings: string[];
  skipped: number;
}

interface PortableSession {
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

type PortableAuth =
  | { kind: "password" }
  | { kind: "private-key"; private_key_path: string }
  | { kind: "agent" }
  | { kind: "none" };

let fallbackIdCounter = 0;

export function parseTaomniSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }

  const warnings: string[] = [];
  const now = resolveNow(options.now);
  const parsedRows = extractTaomniRows(parsed, warnings);
  const sessions = parsedRows.items
    .map(({ row, folderMode, scopeFolder }) =>
      rowToSession(row, folderMode, scopeFolder, options.targetFolder ?? null, now, warnings))
    .filter((session): session is SessionConfig => session !== null);

  const skipped = parsedRows.skipped + parsedRows.items.length - sessions.length;
  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

export function serializeTaomniSessions(
  sessions: readonly SessionConfig[],
  scopeFolder: string | null,
): SessionExportResult {
  const exportedAt = new Date().toISOString();
  const portableSessions = sessions.map((session) => toPortableSession(session, scopeFolder));
  const payload = {
    format: TAOMNI_FORMAT,
    schema_version: SCHEMA_VERSION,
    exported_at: exportedAt,
    security: {
      secrets: "excluded",
      includes_private_key_paths: true,
    },
    scope: {
      folder_path: normalizeGroupPath(scopeFolder),
    },
    sessions: portableSessions,
  };

  return {
    filename: `${slugify(normalizeGroupPath(scopeFolder) ?? "user-sessions")}.taomni-sessions.json`,
    text: JSON.stringify(payload, null, 2),
    mimeType: "application/json",
    warnings: [],
    skipped: 0,
  };
}

export function parseCsvSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new Error("The selected CSV file is empty.");
  }

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const hasHeader = ["name", "session_type", "type", "host"].some((key) => headers.includes(key));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const now = resolveNow(options.now);
  const sessions = dataRows
    .filter((row) => row.some((cell) => cell.trim()))
    .slice(0, MAX_SESSIONS)
    .map((row) => csvRowToSession(row, hasHeader ? headers : null, options.targetFolder ?? null, now, warnings))
    .filter((session): session is SessionConfig => session !== null);

  const skipped = dataRows.length - sessions.length;
  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

export function serializeCsvSessions(
  sessions: readonly SessionConfig[],
  scopeFolder: string | null,
): SessionExportResult {
  const warnings: string[] = [];
  const rows = [
    ["name", "session_type", "host", "port", "username", "group_path"],
  ];

  for (const session of sessions) {
    const sessionType = sanitizeSessionType(session.session_type, warnings);
    if (!sessionType) continue;
    rows.push([
      cleanText(session.name, MAX_NAME_LENGTH),
      sessionType,
      cleanText(session.host, MAX_HOST_LENGTH),
      String(sanitizePort(session.port, DEFAULT_PORTS[sessionType] ?? 0)),
      optionalCleanText(session.username, MAX_NAME_LENGTH) ?? "",
      relativeFolderPath(session.group_path, scopeFolder) ?? "",
    ]);
  }

  const skipped = sessions.length - (rows.length - 1);
  return {
    filename: `${slugify(normalizeGroupPath(scopeFolder) ?? "user-sessions")}.csv`,
    text: `${rows.map((row) => row.map(csvEscape).join(",")).join("\r\n")}\r\n`,
    mimeType: "text/csv",
    warnings: uniqueWarnings(warnings),
    skipped,
  };
}

export function parseMobaXtermSessions(
  input: string | ArrayBuffer | Uint8Array,
  options: SessionImportOptions = {},
): SessionImportResult {
  const text = typeof input === "string" ? input : decodeMobaXtermText(toUint8Array(input));
  assertImportSize(text);

  const warnings: string[] = [];
  const sections = parseMobaIni(text);
  const now = resolveNow(options.now);
  const sessions: SessionConfig[] = [];
  let skipped = 0;

  for (const section of sections) {
    const sectionFolder = normalizeGroupPath(section.subRep);
    const groupPath = combineImportFolder(options.targetFolder ?? null, sectionFolder);

    for (const entry of section.entries) {
      const session = mobaEntryToSession(entry.key, entry.value, groupPath, now, warnings, options.homeDir ?? null);
      if (session) {
        sessions.push(session);
      } else {
        skipped += 1;
      }
    }
  }

  if (sessions.length > MAX_SESSIONS) {
    warnings.push(`Only the first ${MAX_SESSIONS} sessions were imported.`);
    skipped += sessions.length - MAX_SESSIONS;
    sessions.length = MAX_SESSIONS;
  }

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

export function createSessionImportResult(
  sessions: readonly SessionConfig[],
  options: {
    existingSessions?: readonly SessionConfig[];
    warnings?: readonly string[];
    skipped?: number;
    secrets?: readonly SessionImportSecret[];
    externalVault?: ExternalVaultPrompt;
    externalSecretsTool?: SessionImportResult["externalSecretsTool"];
  } = {},
): SessionImportResult {
  return finalizeImportResult(
    sessions.map((session) => ({ ...session })),
    options.skipped ?? 0,
    [...(options.warnings ?? [])],
    options.existingSessions,
    options.secrets ?? [],
    options.externalVault,
    options.externalSecretsTool,
  );
}

export function parseXshellSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const now = resolveNow(options.now);
  const sections = parseIniSections(text);
  const connection = sections.get("connection") ?? new Map<string, string>();
  const terminal = sections.get("terminal") ?? new Map<string, string>();
  // Xshell stores the login user and authentication settings in a dedicated
  // [CONNECTION:AUTHENTICATION] subsection, not in [CONNECTION].
  const authentication = sections.get("connection:authentication") ?? new Map<string, string>();
  const host = cleanText(firstNonEmptyString(getIni(connection, "host"), getIni(connection, "hostname")), MAX_HOST_LENGTH);
  const sessionType = protocolToSessionType(getIni(connection, "protocol"), warnings);
  const folder = folderFromSourcePath(options.sourcePath);
  const name = cleanText(
    firstNonEmptyString(getIni(connection, "name"), nameFromSourcePath(options.sourcePath), host),
    MAX_NAME_LENGTH,
  );
  const username = optionalCleanText(
    firstNonEmptyString(
      getIni(authentication, "username"),
      getIni(connection, "username"),
      getIni(terminal, "username"),
      getIni(connection, "user"),
    ),
    MAX_NAME_LENGTH,
  );
  const authMethod = xshellAuthMethod(sessionType, authentication);
  const session = host
    ? importedSession({
      name,
      sessionType,
      host,
      port: getIni(connection, "port"),
      username,
      groupPath: combineImportFolder(options.targetFolder ?? null, folder),
      authMethod,
      now,
      warnings,
    })
    : null;

  return finalizeImportResult(
    session ? [session] : [],
    session ? 0 : 1,
    session ? warnings : [...warnings, "Skipped an Xshell session because host is empty."],
    options.existingSessions,
  );
}

/**
 * Maps Xshell's `[CONNECTION:AUTHENTICATION]` block to a Taomni auth method.
 * Xshell records the chosen method in `Method` ("Password", "Public Key",
 * "Keyboard Interactive", ...) and, for public-key auth, the *name* of a key
 * in its own key store (e.g. "id_rsa") rather than a filesystem path. We map
 * public-key sessions to a private-key auth, resolving the bare name against
 * the conventional `~/.ssh/` directory so the user only has to confirm it.
 */
function xshellAuthMethod(
  sessionType: string,
  authentication: Map<string, string>,
): AuthMethod | undefined {
  if (sessionType !== "SSH" && sessionType !== "SFTP") return undefined;

  const method = getIni(authentication, "method").toLowerCase().replace(/[^a-z]/g, "");
  const keyName = cleanText(
    firstNonEmptyString(
      getIni(authentication, "userkeyname"),
      getIni(authentication, "userkey"),
      getIni(authentication, "keyname"),
      getIni(authentication, "identity"),
      getIni(authentication, "publickey"),
    ),
    MAX_PATH_LENGTH,
  );

  const usesPublicKey = method.includes("publickey") || (!method && keyName !== "");
  if (!usesPublicKey || !keyName) return undefined;

  return privateKeyAuth(xshellKeyPath(keyName));
}

/**
 * Resolves an Xshell user-key reference to a key path. Bare key names (the
 * common case) are placed under `~/.ssh/`; values that already look like a
 * path (contain a separator or a Windows drive) are kept as-is.
 */
function xshellKeyPath(keyName: string): string {
  const trimmed = keyName.trim();
  if (!trimmed) return "";
  const looksLikePath = /[\\/]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("~");
  return looksLikePath ? trimmed : `~/.ssh/${trimmed}`;
}

export async function parseXshellZipSessions(
  input: ArrayBuffer | Uint8Array,
  options: SessionImportOptions = {},
): Promise<SessionImportResult> {
  const bytes = toUint8Array(input);
  if (bytes.byteLength > MAX_IMPORT_ARCHIVE_BYTES) {
    throw new Error("The selected ZIP file is too large to import safely.");
  }

  const warnings: string[] = [];
  const entries = await readZipTextEntries(bytes, (name) => /\.xsh$/i.test(name), warnings);
  const results = entries.map((entry) =>
    parseXshellSessions(entry.text, {
      ...options,
      existingSessions: undefined,
      sourcePath: entry.name,
    }),
  );

  if (entries.length === 0) {
    warnings.push("No .xsh files were found in the selected ZIP archive.");
  }

  return finalizeImportResult(
    results.flatMap((result) => result.sessions),
    results.reduce((sum, result) => sum + result.skipped, 0),
    [...warnings, ...results.flatMap((result) => result.warnings)],
    options.existingSessions,
  );
}

/**
 * Entry point for the "From file" picker. Xshell exposes two on-disk formats:
 * a single `.xsh` session (a UTF-16 LE INI file) and a `.xts` *Session Export*
 * (a ZIP archive bundling many `.xsh` files). We sniff the bytes — ZIP archives
 * begin with the local-file-header magic `PK\x03\x04` — and route to the ZIP
 * parser or the single-file INI parser accordingly, so the same menu item
 * accepts `.xsh`, `.xts`, and `.zip`.
 */
export async function parseXshellFile(
  input: ArrayBuffer | Uint8Array,
  options: SessionImportOptions = {},
): Promise<SessionImportResult> {
  const bytes = toUint8Array(input);
  if (isZipArchive(bytes)) {
    return parseXshellZipSessions(bytes, options);
  }
  return parseXshellSessions(decodeImportedText(bytes), options);
}

function isZipArchive(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export function parseTabbySessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const now = resolveNow(options.now);
  const { profiles, groupNames } = parseTabbyConfig(text, warnings);
  const vaultDetected = detectTabbyVault(text);
  const profileLookup = tabbyProfileLookup(profiles);
  const includeSecrets = options.includeSecrets === true;
  const sessions: SessionConfig[] = [];
  const secrets: SessionImportSecret[] = [];
  let skipped = 0;
  let externalPasswordCount = 0;

  for (const profile of profiles) {
    const type = cleanText(firstString(profile.type), 32).toLowerCase();
    if (type && type !== "ssh" && type !== "telnet") {
      skipped += 1;
      continue;
    }
    const optionsRecord = isRecord(profile.options) ? profile.options : {};
    const host = cleanText(firstNonEmptyString(optionsRecord.host, optionsRecord.hostname), MAX_HOST_LENGTH);
    if (!host) {
      skipped += 1;
      continue;
    }
    const sessionType = type === "telnet" ? "Telnet" : "SSH";
    const name = cleanText(firstNonEmptyString(profile.name, host), MAX_NAME_LENGTH);
    const profileLabel = name || host;
    const auth = tabbyAuthMethod(profileLabel, sessionType, optionsRecord, includeSecrets, warnings);
    if (auth.passwordHeldExternally) externalPasswordCount += 1;
    const importedOptions = tabbyOptions(profileLabel, profile, optionsRecord, profileLookup, warnings);
    const session = importedSession({
      name,
      sessionType,
      host,
      port: firstKnown(optionsRecord.port, DEFAULT_PORTS[sessionType]),
      username: optionalCleanText(firstNonEmptyString(optionsRecord.user, optionsRecord.username), MAX_NAME_LENGTH),
      groupPath: combineImportFolder(options.targetFolder ?? null, tabbyProfileFolder(profile, groupNames, profileLabel, warnings)),
      authMethod: auth.authMethod,
      options: importedOptions,
      now,
      warnings,
    });
    if (session) {
      sessions.push(session);
      if (auth.password) {
        secrets.push({
          sessionId: session.id,
          kind: "password",
          label: `${session.username ?? "user"}@${session.host}:${session.port}`,
          value: auth.password,
        });
      }
    } else {
      skipped += 1;
    }
  }

  if (externalPasswordCount > 0) {
    if (vaultDetected) {
      warnings.push(
        `Tabby vault detected. Enter your Tabby master password when prompted to recover ${externalPasswordCount} saved password(s); the rest will be looked up in the OS keychain automatically.`,
      );
    } else {
      warnings.push(
        `Tabby keeps remembered passwords in the OS keychain (Credential Manager / Keychain / Secret Service). Taomni will read them automatically; ${externalPasswordCount} profile(s) using password auth still need an entry there.`,
      );
    }
  }

  const externalVault: ExternalVaultPrompt | undefined = vaultDetected
    ? {
        tool: "Tabby",
        rawText: text,
        description:
          "Enter your Tabby master password to unlock saved SSH credentials. Leave blank to skip — passwords stored only in the vault will need to be re-entered on first connect.",
      }
    : undefined;

  return finalizeImportResult(
    sessions,
    skipped,
    warnings,
    options.existingSessions,
    secrets,
    externalVault,
    "tabby",
  );
}

/**
 * Targeted scanner for the Tabby `vault:` block in `config.yaml`. The general
 * Tabby YAML parser ignores top-level keys other than `profiles`/`groups`,
 * so we run a small pass here just to detect whether the file contains an
 * encrypted secret blob worth prompting the user for.
 *
 * Detects: top-level `vault:` mapping with at least `contents:` and
 * `version: 1`. Returns true if both are present.
 */
export function detectTabbyVault(text: string): boolean {
  let inVault = false;
  let vaultIndent = -1;
  let hasContents = false;
  let hasVersion1 = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = stripYamlComment(rawLine);
    if (!stripped.trim()) continue;
    const indent = stripped.match(/^\s*/)?.[0].length ?? 0;
    const line = stripped.trim();

    if (indent === 0) {
      // Leaving the vault block (or never entered one).
      if (inVault) break;
      if (/^vault:\s*$/.test(line) || /^vault:\s*\{?\s*$/.test(line)) {
        inVault = true;
        vaultIndent = indent;
      }
      continue;
    }

    if (!inVault) continue;
    if (indent <= vaultIndent) break;

    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (key === "contents" && value.length > 0) hasContents = true;
    if (key === "version" && value === "1") hasVersion1 = true;
  }

  return inVault && hasContents && hasVersion1;
}

export function parseWindTermSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The selected WindTerm session file is not valid JSON.");
  }

  const rows: WindTermRow[] = [];
  collectWindTermRows(parsed, [], rows, 0);
  const now = resolveNow(options.now);
  const sessions: SessionConfig[] = [];
  let skipped = 0;

  for (const row of rows.slice(0, MAX_SESSIONS)) {
    const sessionType = protocolToSessionType(row.protocol, warnings);
    const session = importedSession({
      name: row.name || row.host,
      sessionType,
      host: row.host,
      port: row.port,
      username: row.username,
      groupPath: combineImportFolder(options.targetFolder ?? null, normalizeGroupPath(row.folder.join(" / "))),
      now,
      warnings,
    });
    if (session) sessions.push(session);
    else skipped += 1;
  }
  skipped += Math.max(0, rows.length - MAX_SESSIONS);
  if (rows.length > MAX_SESSIONS) warnings.push(`Only the first ${MAX_SESSIONS} sessions were imported.`);

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

export function parseItermDynamicProfiles(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const profiles = parseJsonOrPlistProfiles(text, ["Profiles", "profiles"], warnings);
  return sshCommandProfilesToImportResult(profiles, options, warnings, "iTerm2");
}

export function parseTerminalAppProfiles(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const profiles = parsePlistDicts(text);
  return sshCommandProfilesToImportResult(profiles, options, warnings, "Terminal.app");
}

export function parseXmlConnectionSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const now = resolveNow(options.now);
  const sessions: SessionConfig[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const attrs of [...parseXmlElementAttributes(text), ...parseXmlChildElementRecords(text)]) {
    const host = cleanText(firstXmlAttr(attrs, ["hostname", "host", "server", "address", "ipaddress"]), MAX_HOST_LENGTH);
    if (!host) continue;
    const protocol = firstXmlAttr(attrs, ["protocol", "proto", "connectiontype", "type"]);
    if (/^(folder|container|group)$/i.test(protocol)) continue;
    const dedupeKey = [
      host.toLowerCase(),
      firstXmlAttr(attrs, ["port"]),
      firstXmlAttr(attrs, ["username", "user", "login"]).toLowerCase(),
      firstXmlAttr(attrs, ["name", "sessionname", "sessionid", "title"]).toLowerCase(),
    ].join("\u0000");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const sessionType = protocolToSessionType(protocol, warnings);
    const session = importedSession({
      name: cleanText(firstXmlAttr(attrs, ["name", "sessionname", "sessionid", "title"]) || host, MAX_NAME_LENGTH),
      sessionType,
      host,
      port: firstXmlAttr(attrs, ["port"]),
      username: optionalCleanText(firstXmlAttr(attrs, ["username", "user", "login"]), MAX_NAME_LENGTH),
      groupPath: combineImportFolder(
        options.targetFolder ?? null,
        normalizeGroupPath(firstXmlAttr(attrs, ["folder", "group", "parent"])),
      ),
      authMethod: privateKeyAuth(firstXmlAttr(attrs, ["keyfile", "privatekey", "identityfile"])),
      now,
      warnings,
    });
    if (session) sessions.push(session);
    else skipped += 1;
  }

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

export function parseExceedSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const xmlResult = parseXmlConnectionSessions(text, {
    ...options,
    existingSessions: undefined,
  });
  const warnings = [...xmlResult.warnings];
  const sessions = [...xmlResult.sessions];
  let skipped = xmlResult.skipped;
  const now = resolveNow(options.now);
  const sections = parseIniSections(text);

  for (const [sectionName, section] of sections) {
    const hostFromField = firstNonEmptyString(
      getIni(section, "host"),
      getIni(section, "hostname"),
      getIni(section, "server"),
      getIni(section, "address"),
    );
    const command = firstNonEmptyString(
      getIni(section, "command"),
      getIni(section, "startupcommand"),
      getIni(section, "startup"),
      getIni(section, "remotecommand"),
    );
    const sshTarget = parseSshCommand(command);
    const host = cleanText(firstNonEmptyString(hostFromField, sshTarget?.host), MAX_HOST_LENGTH);
    if (!host) continue;

    const session = importedSession({
      name: cleanText(
        firstNonEmptyString(getIni(section, "name"), getIni(section, "title"), sectionName, host),
        MAX_NAME_LENGTH,
      ),
      sessionType: protocolToSessionType(firstNonEmptyString(getIni(section, "protocol"), "SSH"), warnings),
      host,
      port: firstNonEmptyString(getIni(section, "port")) || sshTarget?.port,
      username: optionalCleanText(
        firstNonEmptyString(getIni(section, "username"), getIni(section, "user"), getIni(section, "login"), sshTarget?.username),
        MAX_NAME_LENGTH,
      ),
      groupPath: combineImportFolder(options.targetFolder ?? null, folderFromSourcePath(options.sourcePath)),
      options: command ? { startupCmd: command, description: "Imported from Exceed session file" } : { description: "Imported from Exceed session file" },
      now,
      warnings,
    });
    if (session) sessions.push(session);
    else skipped += 1;
  }

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

export function parseSecureCrtSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const values = parseSecureCrtIni(text);
  const host = cleanText(firstNonEmptyString(values.hostname, values.host), MAX_HOST_LENGTH);
  const keyPath = cleanText(firstNonEmptyString(values["identity filename"], values.identityfile), MAX_PATH_LENGTH);
  const folder = folderFromSourcePath(options.sourcePath);
  const session = host
    ? importedSession({
      name: cleanText(firstNonEmptyString(values.name, nameFromSourcePath(options.sourcePath), host), MAX_NAME_LENGTH),
      sessionType: protocolToSessionType(firstNonEmptyString(values["protocol name"], values.protocol), warnings),
      host,
      port: firstKnown(values["[ssh2] port"], values.port),
      username: optionalCleanText(firstNonEmptyString(values.username), MAX_NAME_LENGTH),
      groupPath: combineImportFolder(options.targetFolder ?? null, folder),
      authMethod: privateKeyAuth(keyPath),
      now: resolveNow(options.now),
      warnings,
    })
    : null;

  return finalizeImportResult(
    session ? [session] : [],
    session ? 0 : 1,
    session ? warnings : [...warnings, "Skipped a SecureCRT session because host is empty."],
    options.existingSessions,
  );
}

/**
 * Import HTTP / SOCKS5 proxies from a ZeroOmega (or SwitchyOmega) options
 * backup (`.bak`), mapping each `FixedProfile` to a Taomni Proxy session.
 *
 * The backup is a flat JSON object where every profile is stored under a
 * `+<name>` key. Only `FixedProfile` entries describe a proxy; their
 * `fallbackProxy: { host, port, scheme }` carries the connection. Schemes
 * other than `http` / `socks5` (e.g. `https`, `socks4`) and non-fixed
 * profiles (`SwitchProfile`, `RuleListProfile`) are skipped.
 */
export function parseZeroOmegaProxies(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text, MAX_ZEROOMEGA_IMPORT_CHARS);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("The selected ZeroOmega backup file is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("The selected ZeroOmega backup file is not a valid options export.");
  }

  const warnings: string[] = [];
  const now = resolveNow(options.now);
  const sessions: SessionConfig[] = [];
  let skipped = 0;

  // Profiles are stored under "+<name>" keys; everything else is settings.
  const profiles = Object.entries(parsed)
    .filter(([key, value]) => key.startsWith("+") && isRecord(value) && value.profileType === "FixedProfile")
    .map(([, value]) => value as Record<string, unknown>);

  for (const profile of profiles.slice(0, MAX_SESSIONS)) {
    const proxy = pickZeroOmegaProxy(profile);
    const name = cleanText(profile.name, MAX_NAME_LENGTH);
    if (!isRecord(proxy)) {
      warnings.push(`Skipped ZeroOmega profile "${name || "(unnamed)"}" because it has no proxy server.`);
      skipped += 1;
      continue;
    }

    const scheme = cleanText(proxy.scheme, 16).toLowerCase();
    const proxyKind = scheme === "http" ? "http" : scheme === "socks5" ? "socks5" : null;
    if (!proxyKind) {
      warnings.push(`Skipped ZeroOmega profile "${name || "(unnamed)"}" with unsupported scheme "${scheme || "(none)"}".`);
      skipped += 1;
      continue;
    }

    const username = optionalCleanText(firstString(proxy.username), MAX_NAME_LENGTH);
    if (firstString(proxy.password)) {
      warnings.push(`Imported ZeroOmega proxy "${name || "(unnamed)"}" without its saved password; re-enter it in the session.`);
    }

    const session = importedSession({
      name,
      sessionType: "Proxy",
      host: cleanText(proxy.host, MAX_HOST_LENGTH),
      port: proxy.port,
      username,
      groupPath: combineImportFolder(options.targetFolder ?? null, null),
      authMethod: username ? "Password" : "None",
      options: { proxyKind },
      now,
      warnings,
    });
    if (session) sessions.push(session);
    else skipped += 1;
  }

  if (profiles.length > MAX_SESSIONS) {
    warnings.push(`Only the first ${MAX_SESSIONS} proxies were imported.`);
    skipped += profiles.length - MAX_SESSIONS;
  }

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

/**
 * Resolve the proxy server from a ZeroOmega FixedProfile. Prefers the
 * catch-all `fallbackProxy`, falling back to per-protocol entries for the
 * rare profiles that only define `proxyForHttps` / `proxyForHttp`.
 */
function pickZeroOmegaProxy(profile: Record<string, unknown>): unknown {
  return (
    profile.fallbackProxy ??
    profile.proxyForHttps ??
    profile.proxyForHttp ??
    profile.proxyForFtp ??
    null
  );
}

export function serializeMobaXtermSessions(
  sessions: readonly SessionConfig[],
  scopeFolder: string | null,
): SessionExportResult {
  const warnings: string[] = [];
  const sectionMap = new Map<string, SessionConfig[]>();
  const rootFolder = mobaRootFolder(scopeFolder);
  ensureMobaSection(sectionMap, rootFolder);

  for (const session of sessions) {
    const folder = mobaFolderForSession(session, scopeFolder);
    ensureMobaSection(sectionMap, folder);
    sectionMap.get(folder)?.push(session);
  }

  const sortedFolders = [...sectionMap.keys()].sort((a, b) => {
    if (a === rootFolder) return -1;
    if (b === rootFolder) return 1;
    return a.localeCompare(b);
  });

  let skipped = 0;
  const lines: string[] = [];
  let sectionIndex = 0;

  for (const folder of sortedFolders) {
    if (folder === rootFolder) {
      lines.push("[Bookmarks]");
      lines.push(`SubRep=${safeMobaIniValue(folder, "folder", warnings)}`);
      lines.push(`ImgNum=${scopeFolder ? "41" : "42"}`);
    } else {
      sectionIndex += 1;
      lines.push("");
      lines.push(`[Bookmarks_${sectionIndex}]`);
      lines.push(`SubRep=${safeMobaIniValue(folder, "folder", warnings)}`);
      lines.push("ImgNum=41");
    }

    const usedNames = new Set<string>();
    for (const session of sectionMap.get(folder) ?? []) {
      const line = mobaSessionLine(session, usedNames, warnings);
      if (line) {
        lines.push(line);
      } else {
        skipped += 1;
      }
    }
  }

  return {
    filename: `${slugify(normalizeGroupPath(scopeFolder) ?? "user-sessions")}.mxtsessions`,
    text: `${lines.join("\r\n")}\r\n`,
    mimeType: "application/octet-stream",
    warnings,
    skipped,
  };
}

interface ImportedSessionInput {
  name: string;
  sessionType: string;
  host: string;
  port: unknown;
  username?: string | null;
  groupPath?: string | null;
  authMethod?: AuthMethod;
  options?: Record<string, unknown>;
  now: number;
  warnings: string[];
}

interface WindTermRow {
  name: string;
  protocol: string;
  host: string;
  port: unknown;
  username: string | null;
  folder: string[];
}

function importedSession(input: ImportedSessionInput): SessionConfig | null {
  const sessionType = sanitizeSessionType(input.sessionType, input.warnings);
  if (!sessionType) return null;
  const host = cleanText(input.host, MAX_HOST_LENGTH);
  if (sessionType !== "LocalShell" && sessionType !== "Serial" && !host) return null;

  return {
    id: createSessionId(),
    name: cleanText(input.name, MAX_NAME_LENGTH) || host || sessionType,
    session_type: sessionType,
    group_path: toStoredGroupPath(input.groupPath ?? null),
    host,
    port: sanitizePort(input.port, DEFAULT_PORTS[sessionType] ?? 0),
    username: input.username ?? null,
    auth_method: input.authMethod ?? (sessionType === "SSH" || sessionType === "SFTP" ? "Password" : "None"),
    options_json: JSON.stringify(sanitizeOptions(input.options ?? {})),
    created_at: input.now,
    updated_at: input.now,
    last_connected_at: null,
    sort_order: 0,
  };
}

function protocolToSessionType(value: unknown, warnings: string[]): string {
  const protocol = cleanText(value, 32).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!protocol || protocol === "ssh" || protocol === "ssh2") return "SSH";
  if (protocol === "sftp") return "SFTP";
  if (protocol === "telnet") return "Telnet";
  if (protocol === "rdp" || protocol === "rdpfile") return "RDP";
  if (protocol === "vnc") return "VNC";
  if (protocol === "ftp") return "FTP";
  if (protocol === "serial") return "Serial";
  warnings.push(`Imported unsupported protocol "${String(value)}" as SSH.`);
  return "SSH";
}

function privateKeyAuth(keyPath: string): AuthMethod | undefined {
  const cleaned = cleanText(keyPath, MAX_PATH_LENGTH);
  return cleaned ? { PrivateKey: { key_path: cleaned } } : undefined;
}

function parseIniSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = "";
  sections.set(current, new Map());

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)]$/.exec(line);
    if (sectionMatch) {
      current = sectionMatch[1].trim().toLowerCase();
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;
    sections.get(current)?.set(line.slice(0, equalsIndex).trim().toLowerCase(), line.slice(equalsIndex + 1).trim());
  }

  return sections;
}

function getIni(section: Map<string, string>, key: string): string {
  return section.get(key.toLowerCase()) ?? "";
}

function tabbyProfileFolder(
  profile: Record<string, unknown>,
  groupNames: Map<string, string>,
  profileLabel: string,
  warnings: string[],
): string | null {
  const raw = firstNonEmptyString(
    profile.group,
    profile.groupPath,
    profile.group_path,
    profile.folder,
    profile.folderPath,
    profile.folder_path,
    profile.category,
  );
  const cleaned = cleanText(raw, MAX_OPTION_LENGTH);
  if (!cleaned) return null;

  const resolved = groupNames.get(cleaned);
  if (resolved) return normalizeGroupPath(resolved);

  if (TABBY_UUID_PATTERN.test(cleaned)) {
    warnings.push(`Tabby profile "${profileLabel}" references group "${cleaned}" but no matching entry was found under groups: — imported under the raw id.`);
  }
  return normalizeGroupPath(cleaned);
}

const TABBY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tabbyProfileLookup(profiles: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const lookup = new Map<string, Record<string, unknown>>();
  for (const profile of profiles) {
    for (const key of [
      firstString(profile.id),
      firstString(profile.name),
      firstString(profile.title),
    ]) {
      const normalized = key.trim();
      if (normalized && !lookup.has(normalized)) lookup.set(normalized, profile);
    }
  }
  return lookup;
}

function tabbyOptions(
  profileName: string,
  profile: Record<string, unknown>,
  optionsRecord: Record<string, unknown>,
  profileLookup: Map<string, Record<string, unknown>>,
  warnings: string[],
): Record<string, unknown> {
  const imported: Record<string, unknown> = {
    description: "Imported from Tabby",
  };

  const x11 = firstKnown(optionsRecord.x11, optionsRecord.x11Forwarding, optionsRecord.x11_forwarding);
  if (typeof x11 === "boolean") imported.x11 = x11;

  if (optionsRecord.agentForward === true || optionsRecord.agentForwarding === true) {
    imported.agentForward = true;
    warnings.push("Imported Tabby agent forwarding as metadata; Taomni does not enable SSH agent forwarding at runtime yet.");
  }

  const jump = resolveTabbyJumpHost(profileName, optionsRecord.jumpHost, profileLookup, warnings);
  if (jump) {
    imported.useJump = true;
    imported.jumpHost = jump.host;
    imported.jumpPort = String(jump.port);
    if (jump.username) imported.jumpUser = jump.username;
    warnings.push("Imported Tabby jump-host settings as metadata; Taomni does not use jump hosts at runtime yet.");
  }

  const proxyCommand = cleanText(firstNonEmptyString(optionsRecord.proxyCommand), MAX_OPTION_LENGTH);
  if (proxyCommand) {
    warnings.push(`Skipped Tabby proxy command for "${profileName}" because Taomni session import cannot map proxy commands yet.`);
  }

  const tags = cleanText(firstNonEmptyString(profile.tags, profile.tag), MAX_OPTION_LENGTH);
  if (tags) imported.tags = tags;

  return imported;
}

function tabbyAuthMethod(
  profileName: string,
  sessionType: string,
  optionsRecord: Record<string, unknown>,
  includeSecrets: boolean,
  warnings: string[],
): { authMethod?: AuthMethod; password?: string; passwordHeldExternally?: boolean } {
  if (sessionType !== "SSH") return {};

  const auth = cleanText(firstString(optionsRecord.auth), 64).toLowerCase();
  const keyPath = firstTabbyPrivateKeyPath(optionsRecord);
  const password = cleanText(firstNonEmptyString(optionsRecord.password), MAX_OPTION_LENGTH);

  if (auth === "agent") {
    warnings.push("Imported Tabby SSH agent authentication, but Taomni SSH agent authentication is not implemented at runtime yet.");
    return { authMethod: "Agent" };
  }

  if (auth === "password" || auth === "keyboardinteractive" || auth === "keyboard-interactive") {
    if (password && includeSecrets) return { authMethod: "Password", password };
    if (password && !includeSecrets) {
      warnings.push(`Skipped Tabby saved password for "${profileName}" because secret import was not enabled.`);
      return { authMethod: "Password" };
    }
    return { authMethod: "Password", passwordHeldExternally: includeSecrets };
  }

  if (keyPath) {
    if (includeSecrets) return { authMethod: { PrivateKey: { key_path: keyPath } } };
    warnings.push(`Skipped Tabby private key path for "${profileName}" because secret import was not enabled.`);
  } else if (auth === "publickey" || auth === "public-key") {
    warnings.push(`Tabby profile "${profileName}" uses public-key auth but has no importable private key path.`);
  }

  if (password) {
    if (includeSecrets) return { authMethod: "Password", password };
    warnings.push(`Skipped Tabby saved password for "${profileName}" because secret import was not enabled.`);
  }

  return { authMethod: "Password" };
}

function firstTabbyPrivateKeyPath(optionsRecord: Record<string, unknown>): string {
  const candidates = [
    optionsRecord.privateKeys,
    optionsRecord.privateKey,
    optionsRecord.private_key,
    optionsRecord.keyFile,
    optionsRecord.identityFile,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const path = normalizeImportPath(firstString(item));
        if (path) return path;
      }
    } else {
      const path = normalizeImportPath(firstString(candidate));
      if (path) return path;
    }
  }

  return "";
}

function normalizeImportPath(value: string): string {
  let path = cleanText(value, MAX_PATH_LENGTH);
  if (!path) return "";
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(path.replace(/^file:\/\/\/?/i, ""));
    } catch {
      path = path.replace(/^file:\/\/\/?/i, "");
    }
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  }
  return path;
}

function resolveTabbyJumpHost(
  profileName: string,
  value: unknown,
  profileLookup: Map<string, Record<string, unknown>>,
  warnings: string[],
): { host: string; port: number; username: string | null } | null {
  if (isRecord(value)) {
    const direct = tabbyProfileConnection(value);
    if (direct) return direct;
  }

  const ref = cleanText(firstString(value), MAX_HOST_LENGTH);
  if (!ref) return null;

  const referenced = profileLookup.get(ref);
  if (referenced) {
    const optionsRecord = isRecord(referenced.options) ? referenced.options : {};
    const connection = tabbyProfileConnection(optionsRecord);
    if (connection) return connection;
    warnings.push(`Could not import Tabby jump host "${ref}" for "${profileName}" because the referenced profile has no host.`);
    return null;
  }

  if (ref.toLowerCase().startsWith("ssh:")) {
    warnings.push(`Could not resolve Tabby jump host profile "${ref}" for "${profileName}".`);
    return null;
  }

  const direct = parseJumpTarget(ref);
  if (direct) return direct;
  warnings.push(`Could not import Tabby jump host "${ref}" for "${profileName}".`);
  return null;
}

function tabbyProfileConnection(value: Record<string, unknown>): { host: string; port: number; username: string | null } | null {
  const host = cleanText(firstNonEmptyString(value.host, value.hostname), MAX_HOST_LENGTH);
  if (!host) return null;
  return {
    host,
    port: sanitizePort(firstKnown(value.port), DEFAULT_PORTS.SSH),
    username: optionalCleanText(firstNonEmptyString(value.user, value.username), MAX_NAME_LENGTH),
  };
}

function parseJumpTarget(value: string): { host: string; port: number; username: string | null } | null {
  let target = value.trim();
  let username: string | null = null;
  if (target.includes("@")) {
    const parts = target.split("@");
    username = optionalCleanText(parts.slice(0, -1).join("@"), MAX_NAME_LENGTH);
    target = parts[parts.length - 1] ?? "";
  }

  let host = target;
  let port = DEFAULT_PORTS.SSH;
  const portMatch = /^(.+):(\d+)$/.exec(target);
  if (portMatch && !target.includes("]:")) {
    host = portMatch[1];
    port = sanitizePort(portMatch[2], DEFAULT_PORTS.SSH);
  }
  host = cleanText(host.replace(/^\[|\]$/g, ""), MAX_HOST_LENGTH);
  return host ? { host, port, username } : null;
}

function parseTabbyConfig(
  text: string,
  warnings: string[],
): { profiles: Array<Record<string, unknown>>; groupNames: Map<string, string> } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      const rawProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
      const profiles = rawProfiles.filter(isRecord);
      const groupNames = new Map<string, string>();
      if (Array.isArray(parsed.groups)) {
        for (const group of parsed.groups) {
          if (!isRecord(group)) continue;
          const id = cleanText(firstString(group.id), MAX_OPTION_LENGTH);
          const groupName = cleanText(firstString(group.name), MAX_OPTION_LENGTH);
          if (id && groupName) groupNames.set(id, groupName);
        }
      }
      if (profiles.length === 0) warnings.push("No Tabby profiles were found in the selected config.");
      return { profiles, groupNames };
    }
  } catch {
    // Tabby normally uses YAML; JSON imports are accepted as a convenience.
  }

  return parseTabbyYaml(text, warnings);
}

function parseTabbyYaml(
  text: string,
  warnings: string[],
): { profiles: Array<Record<string, unknown>>; groupNames: Map<string, string> } {
  const profiles: Array<Record<string, unknown>> = [];
  const groupNames = new Map<string, string>();
  let section: "none" | "profiles" | "groups" = "none";
  let current: Record<string, unknown> | null = null;
  let currentOptions: Record<string, unknown> | null = null;
  let profileIndent = -1;
  let optionsIndent = -1;
  let arrayTarget: unknown[] | null = null;
  let arrayIndent = -1;
  let currentGroup: { id: string; name: string } | null = null;
  let groupIndent = -1;

  const flushProfile = () => {
    if (current) profiles.push(current);
    current = null;
    currentOptions = null;
    arrayTarget = null;
    profileIndent = -1;
    optionsIndent = -1;
  };

  const flushGroup = () => {
    if (currentGroup && currentGroup.id && currentGroup.name) {
      groupNames.set(currentGroup.id, currentGroup.name);
    }
    currentGroup = null;
    groupIndent = -1;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = stripYamlComment(rawLine);
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const line = withoutComment.trim();

    // Detect a top-level section change (indent === 0, "key:" form).
    if (indent === 0 && /^[A-Za-z][\w-]*:\s*(.*)$/.test(line)) {
      flushProfile();
      flushGroup();
      const key = line.split(":", 1)[0]?.trim() ?? "";
      if (key === "profiles") section = "profiles";
      else if (key === "groups") section = "groups";
      else section = "none";
      continue;
    }

    if (section === "profiles") {
      if (arrayTarget && indent <= arrayIndent) arrayTarget = null;

      if (arrayTarget && line.startsWith("- ") && indent > arrayIndent) {
        arrayTarget.push(parseSimpleScalar(line.slice(2).trim()));
        continue;
      }

      if (line.startsWith("- ") && (!current || indent <= profileIndent)) {
        flushProfile();
        current = { options: {} };
        currentOptions = current.options as Record<string, unknown>;
        profileIndent = indent;
        optionsIndent = -1;
        const rest = line.slice(2).trim();
        if (rest) assignSimpleYamlPair(current, rest);
        continue;
      }

      if (!current || indent <= profileIndent) continue;
      if (currentOptions && optionsIndent >= 0 && indent <= optionsIndent) {
        currentOptions = current.options as Record<string, unknown>;
      }
      if (line === "options:" || line.startsWith("options:")) {
        currentOptions = {};
        current.options = currentOptions;
        optionsIndent = indent;
        continue;
      }

      const target = optionsIndent >= 0 && indent > optionsIndent && currentOptions ? currentOptions : current;
      const emptyKey = yamlEmptyKey(line);
      if (emptyKey) {
        const container = yamlEmptyContainer(emptyKey);
        target[emptyKey] = container;
        if (Array.isArray(container)) {
          arrayTarget = container;
          arrayIndent = indent;
        }
        continue;
      }

      if (optionsIndent >= 0 && indent > optionsIndent && currentOptions) {
        assignSimpleYamlPair(currentOptions, line);
      } else {
        assignSimpleYamlPair(current, line);
      }
      continue;
    }

    if (section === "groups") {
      if (line.startsWith("- ") && (!currentGroup || indent <= groupIndent)) {
        flushGroup();
        currentGroup = { id: "", name: "" };
        groupIndent = indent;
        const rest = line.slice(2).trim();
        if (rest) collectTabbyGroupField(currentGroup, rest);
        continue;
      }
      if (currentGroup && indent > groupIndent) {
        collectTabbyGroupField(currentGroup, line);
      }
    }
  }

  flushProfile();
  flushGroup();

  if (profiles.length === 0) warnings.push("No Tabby profiles were found in the selected config.");
  return { profiles, groupNames };
}

function collectTabbyGroupField(group: { id: string; name: string }, line: string) {
  const separator = line.indexOf(":");
  if (separator <= 0) return;
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  if (key === "id") group.id = String(parseSimpleScalar(value));
  else if (key === "name") group.name = String(parseSimpleScalar(value));
}

function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function yamlEmptyKey(line: string): string | null {
  const separator = line.indexOf(":");
  if (separator <= 0) return null;
  const value = line.slice(separator + 1).trim();
  return value ? null : line.slice(0, separator).trim();
}

function yamlEmptyContainer(key: string): Record<string, unknown> | unknown[] {
  return /^(privateKeys|forwardedPorts|scripts)$/i.test(key) ? [] : {};
}

function assignSimpleYamlPair(target: Record<string, unknown>, line: string) {
  const separator = line.indexOf(":");
  if (separator <= 0) return;
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  target[key] = parseSimpleScalar(value);
}

function parseSimpleScalar(value: string): string | number | boolean | unknown[] {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "null" || trimmed === "~") return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitFlowItems(trimmed.slice(1, -1)).map(parseSimpleScalar).filter((item) => item !== "");
  }
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return trimmed;
}

function splitFlowItems(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      current += char;
      quote = char;
      continue;
    }
    if (char === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function collectWindTermRows(value: unknown, folders: string[], rows: WindTermRow[], depth: number) {
  if (depth > 32) return;
  if (Array.isArray(value)) {
    for (const item of value) collectWindTermRows(item, folders, rows, depth + 1);
    return;
  }
  if (!isRecord(value)) return;

  const host = cleanText(firstNonEmptyString(value.host, value.hostname, value.address, value.ip), MAX_HOST_LENGTH);
  const name = cleanText(firstNonEmptyString(value.name, value.title, value.label), MAX_NAME_LENGTH);
  const explicitFolder = cleanText(firstNonEmptyString(value.folder, value.group, value.groupName, value.group_name), MAX_NAME_LENGTH);
  const ownFolder = !host && name ? name : explicitFolder;
  const nextFolders = ownFolder ? [...folders, ownFolder] : folders;

  if (host) {
    rows.push({
      name: name || host,
      protocol: firstNonEmptyString(value.protocol, value.type, value.sessionType, value.session_type),
      host,
      port: firstKnown(value.port, value.sshPort, value.ssh_port),
      username: optionalCleanText(firstNonEmptyString(value.username, value.user, value.login), MAX_NAME_LENGTH),
      folder: explicitFolder ? [...folders, explicitFolder] : folders,
    });
  }

  for (const key of ["children", "sessions", "items", "nodes", "data", "groups"]) {
    if (key in value) collectWindTermRows(value[key], nextFolders, rows, depth + 1);
  }
}

function parseJsonOrPlistProfiles(
  text: string,
  arrayKeys: string[],
  warnings: string[],
): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (isRecord(parsed)) {
      for (const key of arrayKeys) {
        const value = parsed[key];
        if (Array.isArray(value)) return value.filter(isRecord);
      }
    }
  } catch {
    // XML plist fallback below.
  }

  const plistProfiles = parsePlistDicts(text);
  if (plistProfiles.length === 0) warnings.push("No profiles were found in the selected file.");
  return plistProfiles;
}

function sshCommandProfilesToImportResult(
  profiles: Array<Record<string, unknown>>,
  options: SessionImportOptions,
  warnings: string[],
  sourceLabel: string,
): SessionImportResult {
  const now = resolveNow(options.now);
  const sessions: SessionConfig[] = [];
  let skipped = 0;

  for (const profile of profiles) {
    const command = firstString(
      profile.Command,
      profile.command,
      profile.CommandString,
      profile.commandString,
      profile["Custom Command"],
      profile["custom command"],
    );
    const parsed = parseSshCommand(command);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    const session = importedSession({
      name: cleanText(firstNonEmptyString(profile.Name, profile.name, profile.ProfileName, parsed.host), MAX_NAME_LENGTH),
      sessionType: "SSH",
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      groupPath: options.targetFolder ?? null,
      options: { description: `Imported from ${sourceLabel}` },
      now,
      warnings,
    });
    if (session) sessions.push(session);
    else skipped += 1;
  }

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions);
}

function parseSshCommand(command: string): { host: string; port: number; username: string | null } | null {
  const tokens = shellSplit(command);
  const sshIndex = tokens.findIndex((token) => token === "ssh" || token.endsWith("/ssh") || token.endsWith("\\ssh.exe"));
  if (sshIndex < 0) return null;

  let port = 22;
  let username: string | null = null;
  let host = "";
  for (let i = sshIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token === "-p" && tokens[i + 1]) {
      port = sanitizePort(tokens[i + 1], 22);
      i += 1;
      continue;
    }
    if (token.startsWith("-p") && token.length > 2) {
      port = sanitizePort(token.slice(2), 22);
      continue;
    }
    if (token === "-l" && tokens[i + 1]) {
      username = cleanText(tokens[i + 1], MAX_NAME_LENGTH) || null;
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      if (/^-[bcDeFIiJmOoQSRSWw]$/.test(token) && tokens[i + 1]) i += 1;
      continue;
    }
    host = token;
    break;
  }

  if (!host) return null;
  if (host.includes("@")) {
    const [user, rawHost] = host.split("@");
    username = cleanText(user, MAX_NAME_LENGTH) || username;
    host = rawHost;
  }
  host = cleanText(host, MAX_HOST_LENGTH);
  return host ? { host, port, username } : null;
}

function shellSplit(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: string | null = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

function parsePlistDicts(text: string): Array<Record<string, unknown>> {
  const dicts: Array<Record<string, unknown>> = [];
  for (const dictMatch of text.matchAll(/<dict\b[^>]*>([\s\S]*?)<\/dict>/gi)) {
    const dictText = dictMatch[1];
    const dict: Record<string, unknown> = {};
    const pairPattern = /<key>([\s\S]*?)<\/key>\s*<(string|integer|real|true|false)\b[^>]*>(?:([\s\S]*?)<\/\2>)?/gi;
    for (const pair of dictText.matchAll(pairPattern)) {
      const key = decodeXml(pair[1]);
      const kind = pair[2].toLowerCase();
      const rawValue = decodeXml(pair[3] ?? "");
      dict[key] = kind === "true" ? true : kind === "false" ? false : parseSimpleScalar(rawValue);
    }
    if (Object.keys(dict).length > 0) dicts.push(dict);
  }
  return dicts;
}

function parseXmlElementAttributes(text: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const match of text.matchAll(/<([A-Za-z_][\w:.-]*)(\s+[^<>]*?)\/?>/g)) {
    const tag = match[1].toLowerCase();
    if (tag.startsWith("?") || tag === "plist" || tag === "key" || tag === "string") continue;
    const attrs: Record<string, string> = {};
    for (const attr of match[2].matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[attr[1].toLowerCase()] = decodeXml(attr[2] ?? attr[3] ?? "");
    }
    if (Object.keys(attrs).length > 0) out.push(attrs);
  }
  return out;
}

function parseXmlChildElementRecords(text: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const block of text.matchAll(/<([A-Za-z_][\w:.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const body = block[2];
    if (!/<(?:Host|Hostname|Server|Address|IPAddress)\b/i.test(body)) continue;
    const attrs: Record<string, string> = {};
    for (const child of body.matchAll(/<([A-Za-z_][\w:.-]*)\b[^>]*>([^<>]*)<\/\1>/g)) {
      const key = child[1].toLowerCase();
      const value = decodeXml(child[2].trim());
      if (value) attrs[key] = value;
    }
    if (Object.keys(attrs).length > 0) out.push(attrs);
  }
  return out;
}

function firstXmlAttr(attrs: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = attrs[key.toLowerCase()];
    if (value) return value;
  }
  return "";
}

function parseSecureCrtIni(text: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^[A-Z]:"([^"]+)"=(.*)$/.exec(rawLine.trim());
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    values[key] = /^[0-9a-f]{8}$/i.test(value) ? Number.parseInt(value, 16) : value;
  }
  return values;
}

interface ZipTextEntry {
  name: string;
  text: string;
}

interface ZipCentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

async function readZipTextEntries(
  bytes: Uint8Array,
  matches: (name: string) => boolean,
  warnings: string[],
): Promise<ZipTextEntry[]> {
  const entries = parseZipCentralDirectory(bytes);
  const out: ZipTextEntry[] = [];
  let totalUncompressed = 0;

  for (const entry of entries) {
    if (entry.isDirectory || !matches(entry.name)) continue;
    totalUncompressed += entry.uncompressedSize;
    if (totalUncompressed > MAX_IMPORT_ARCHIVE_BYTES) {
      warnings.push("Skipped remaining ZIP entries because the expanded archive is too large.");
      break;
    }

    try {
      const data = await inflateZipEntry(bytes, entry);
      out.push({ name: entry.name, text: decodeImportedText(data) });
    } catch (error) {
      warnings.push(`Skipped "${entry.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return out;
}

function parseZipCentralDirectory(bytes: Uint8Array): ZipCentralEntry[] {
  const eocdOffset = findZipEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    throw new Error("The selected file is not a valid ZIP archive.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const entries: ZipCentralEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("The ZIP central directory is malformed.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new Error("The ZIP central directory is malformed.");
    const name = decodeZipName(bytes.slice(nameStart, nameEnd), flags);
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith("/"),
    });
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

function findZipEndOfCentralDirectory(bytes: Uint8Array): number {
  const minOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  return -1;
}

async function inflateZipEntry(bytes: Uint8Array, entry: ZipCentralEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.byteLength || view.getUint32(offset, true) !== 0x04034b50) {
    throw new Error("local header is malformed");
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.byteLength) throw new Error("entry data is truncated");
  const compressed = bytes.slice(dataStart, dataEnd);

  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawWithDecompressionStream(compressed);
  throw new Error(`unsupported ZIP compression method ${entry.method}`);
}

async function inflateRawWithDecompressionStream(bytes: Uint8Array): Promise<Uint8Array> {
  const Decompression = globalThis.DecompressionStream;
  if (typeof Decompression !== "function") {
    throw new Error("this runtime cannot decompress deflated ZIP entries");
  }

  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([source]).stream().pipeThrough(new Decompression("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

function decodeZipName(bytes: Uint8Array, flags: number): string {
  const encoding = (flags & 0x0800) !== 0 ? "utf-8" : "windows-1252";
  try {
    return new TextDecoder(encoding).decode(bytes).replace(/\\/g, "/");
  } catch {
    return new TextDecoder("utf-8").decode(bytes).replace(/\\/g, "/");
  }
}

export function decodeImportedText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.slice(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.slice(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.slice(2));
  }
  // Xshell .xsh files are UTF-16 LE and usually carry a BOM (handled above),
  // but fall back to a null-byte heuristic for BOM-less UTF-16 content.
  if (bytes.length >= 2 && countNullBytes(bytes) > bytes.length / 8) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function countNullBytes(bytes: Uint8Array): number {
  let count = 0;
  // Cap the scan for very large buffers; a representative sample is enough.
  const limit = Math.min(bytes.length, 4096);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) count += 1;
  }
  return bytes.length > limit ? Math.round((count / limit) * bytes.length) : count;
}

function folderFromSourcePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  return normalizeGroupPath(parts.join(" / "));
}

function nameFromSourcePath(path: string | null | undefined): string {
  if (!path) return "";
  const name = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return name.replace(/\.[^.]+$/, "");
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractTaomniRows(
  parsed: unknown,
  warnings: string[],
): {
  items: Array<{ row: unknown; folderMode: "portable" | "legacy"; scopeFolder: string | null }>;
  skipped: number;
} {
  if (Array.isArray(parsed)) {
    warnings.push("Imported legacy Taomni JSON array format.");
    const limited = limitRows(parsed, warnings);
    return {
      items: limited.rows.map((row) => ({ row, folderMode: "legacy", scopeFolder: null })),
      skipped: limited.skipped,
    };
  }

  if (!isRecord(parsed)) {
    throw new Error("The selected file does not contain a sessions array.");
  }

  if (parsed.format === TAOMNI_FORMAT || parsed.format === LEGACY_FORMAT) {
    if (parsed.schema_version !== SCHEMA_VERSION) {
      throw new Error(`Unsupported Taomni sessions schema version: ${String(parsed.schema_version)}.`);
    }
    if (!Array.isArray(parsed.sessions)) {
      throw new Error("The Taomni sessions file does not contain a sessions array.");
    }
    const scopeFolder = isRecord(parsed.scope)
      ? normalizeGroupPath(firstString(parsed.scope.folder_path, parsed.scope.folder))
      : null;
    const limited = limitRows(parsed.sessions, warnings);
    return {
      items: limited.rows.map((row) => ({ row, folderMode: "portable", scopeFolder })),
      skipped: limited.skipped,
    };
  }

  if (Array.isArray(parsed.sessions)) {
    warnings.push("Imported legacy Taomni JSON object format.");
    const limited = limitRows(parsed.sessions, warnings);
    return {
      items: limited.rows.map((row) => ({ row, folderMode: "legacy", scopeFolder: null })),
      skipped: limited.skipped,
    };
  }

  throw new Error("The selected file does not contain a sessions array.");
}

function rowToSession(
  row: unknown,
  folderMode: "portable" | "legacy",
  scopeFolder: string | null,
  targetFolder: string | null,
  now: number,
  warnings: string[],
): SessionConfig | null {
  if (!isRecord(row)) {
    warnings.push("Skipped a session entry because it is not an object.");
    return null;
  }

  const sessionType = sanitizeSessionType(firstString(row.type, row.session_type), warnings);
  if (!sessionType) return null;

  const host = cleanText(firstString(row.host), MAX_HOST_LENGTH);
  if (sessionType !== "LocalShell" && sessionType !== "Serial" && !host) {
    warnings.push(`Skipped "${firstString(row.name) || sessionType}" because host is empty.`);
    return null;
  }

  const rowFolder = folderMode === "portable"
    ? combineImportFolder(scopeFolder, normalizeGroupPath(firstString(row.folder_path, row.folder)))
    : normalizeGroupPath(firstString(row.group_path));

  const groupPath = folderMode === "legacy" && targetFolder
    ? toStoredGroupPath(targetFolder)
    : toStoredGroupPath(combineImportFolder(targetFolder, rowFolder));

  const name = cleanText(firstString(row.name), MAX_NAME_LENGTH) || host || sessionType;
  const username = optionalCleanText(firstString(row.username), MAX_NAME_LENGTH);
  const auth = folderMode === "portable"
    ? portableAuthToAuthMethod(row.auth)
    : sanitizeAuthMethod(row.auth_method);
  const optionsJson = JSON.stringify(sanitizeOptions(firstKnown(row.options, row.options_json)));

  return {
    id: createSessionId(),
    name,
    session_type: sessionType,
    group_path: groupPath,
    host,
    port: sanitizePort(row.port, DEFAULT_PORTS[sessionType] ?? 0),
    username,
    auth_method: auth,
    options_json: optionsJson,
    created_at: now,
    updated_at: now,
    last_connected_at: null,
    sort_order: sanitizeInteger(row.sort_order, 0),
  };
}

function toPortableSession(session: SessionConfig, scopeFolder: string | null): PortableSession {
  return {
    name: cleanText(session.name, MAX_NAME_LENGTH),
    type: sanitizeSessionType(session.session_type, []) ?? "SSH",
    folder_path: relativeFolderPath(session.group_path, scopeFolder),
    host: cleanText(session.host, MAX_HOST_LENGTH),
    port: sanitizePort(session.port, DEFAULT_PORTS[session.session_type] ?? 0),
    username: optionalCleanText(session.username, MAX_NAME_LENGTH),
    auth: authMethodToPortable(session.auth_method),
    options: sanitizeOptions(session.options_json),
    sort_order: sanitizeInteger(session.sort_order, 0),
  };
}

function csvRowToSession(
  row: string[],
  headers: string[] | null,
  targetFolder: string | null,
  now: number,
  warnings: string[],
): SessionConfig | null {
  const get = (name: string, index: number) => {
    if (!headers) return row[index] ?? "";
    const headerIndex = headers.indexOf(name);
    return headerIndex >= 0 ? row[headerIndex] ?? "" : "";
  };

  const typeValue = get("session_type", 1) || get("type", 1) || "SSH";
  const sessionType = sanitizeSessionType(typeValue, warnings);
  if (!sessionType) return null;

  const host = cleanText(get("host", 2), MAX_HOST_LENGTH);
  if (sessionType !== "LocalShell" && sessionType !== "Serial" && !host) {
    warnings.push("Skipped a CSV row because host is empty.");
    return null;
  }

  const name = cleanText(get("name", 0), MAX_NAME_LENGTH) || host || sessionType;
  const username = optionalCleanText(get("username", 4) || get("user", 4), MAX_NAME_LENGTH);
  const importedFolder = normalizeGroupPath(get("group_path", 5) || get("folder_path", 5) || get("folder", 5));
  const groupPath = combineImportFolder(targetFolder, importedFolder);

  return {
    id: createSessionId(),
    name,
    session_type: sessionType,
    group_path: toStoredGroupPath(groupPath),
    host,
    port: sanitizePort(get("port", 3), DEFAULT_PORTS[sessionType] ?? 0),
    username,
    auth_method: sessionType === "SSH" || sessionType === "SFTP" ? "Password" : "None",
    options_json: "{}",
    created_at: now,
    updated_at: now,
    last_connected_at: null,
    sort_order: 0,
  };
}

interface MobaSection {
  name: string;
  subRep: string | null;
  entries: Array<{ key: string; value: string }>;
}

function parseMobaIni(text: string): MobaSection[] {
  const sections: MobaSection[] = [];
  let current: MobaSection = { name: "Bookmarks", subRep: null, entries: [] };
  let hasExplicitSection = false;

  const pushCurrent = () => {
    if (hasExplicitSection || current.entries.length > 0 || current.subRep !== null) {
      sections.push(current);
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) continue;

    const sectionMatch = /^\[([^\]]+)]$/.exec(trimmed);
    if (sectionMatch) {
      pushCurrent();
      current = { name: sectionMatch[1], subRep: null, entries: [] };
      hasExplicitSection = true;
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1);

    if (key === "SubRep") {
      current.subRep = value;
    } else if (key !== "ImgNum") {
      current.entries.push({ key, value });
    }
  }

  pushCurrent();
  return sections.filter((section) => section.name === "Bookmarks" || /^Bookmarks_\d+$/.test(section.name));
}

function mobaEntryToSession(
  rawName: string,
  rawValue: string,
  groupPath: string | null,
  now: number,
  warnings: string[],
  homeDir: string | null,
): SessionConfig | null {
  const value = rawValue.trimStart();
  const parts = value.split("#");
  const iconIndex = parts.findIndex((part, index) => /^\d+$/.test(part) && (parts[index + 1] ?? "").includes("%"));
  if (iconIndex < 0) {
    warnings.push(`Skipped "${rawName}" because it is not a supported MobaXterm session line.`);
    return null;
  }

  const basic = (parts[iconIndex + 1] ?? "").split("%");
  const typeCode = basic[0] ?? "";
  const sessionType = MOBAXTERM_TYPE_TO_SESSION[typeCode];
  if (!sessionType) {
    warnings.push(`Skipped "${rawName}" because MobaXterm type ${typeCode || "(empty)"} is not supported.`);
    return null;
  }

  const host = cleanText(mobaUnescape(basic[1] ?? ""), MAX_HOST_LENGTH);
  if (!host) {
    warnings.push(`Skipped "${rawName}" because host is empty.`);
    return null;
  }

  const name = cleanText(mobaUnescape(rawName), MAX_NAME_LENGTH) || host;
  const port = sanitizePort(basic[2], DEFAULT_PORTS[sessionType] ?? 0);
  const username = sessionType === "VNC" ? null : optionalCleanText(mobaUnescape(basic[3] ?? ""), MAX_NAME_LENGTH);
  const options = mobaBasicToOptions(sessionType, basic, parts[iconIndex + 4] ?? "");
  const authMethod = mobaBasicToAuth(sessionType, basic, homeDir);

  return {
    id: createSessionId(),
    name,
    session_type: sessionType,
    group_path: toStoredGroupPath(groupPath),
    host,
    port,
    username,
    auth_method: authMethod,
    options_json: JSON.stringify(options),
    created_at: now,
    updated_at: now,
    last_connected_at: null,
    sort_order: 0,
  };
}

function mobaBasicToOptions(
  sessionType: string,
  basic: string[],
  rawComment: string,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const comment = cleanText(mobaUnescape(rawComment), MAX_OPTION_LENGTH).trim();
  if (comment) options.description = comment;

  if (sessionType === "SSH") {
    options.x11 = basic[5] !== "0";
    options.compression = basic[6] !== "0";
    const startupCmd = cleanText(mobaUnescape(basic[7] ?? ""), MAX_OPTION_LENGTH);
    if (startupCmd) options.startupCmd = startupCmd;
    if (basic[11] === "-1") options.doNotExit = true;
    addMobaJumpOptions(options, basic[8], basic[9], basic[10]);
  } else if (sessionType === "SFTP") {
    options.compression = basic[5] === "-1";
  } else if (sessionType === "RDP") {
    const remoteCommand = cleanText(mobaUnescape(basic[12] ?? ""), MAX_OPTION_LENGTH);
    if (remoteCommand) options.startupCmd = remoteCommand;
    addMobaJumpOptions(options, basic[13], basic[14], basic[15]);
  } else if (sessionType === "VNC") {
    addMobaJumpOptions(options, basic[5], basic[6], basic[7]);
  }

  return sanitizeOptions(options);
}

function addMobaJumpOptions(
  options: Record<string, unknown>,
  hostList: string | undefined,
  portList: string | undefined,
  userList: string | undefined,
) {
  const jumpHost = firstPipeValue(hostList);
  if (!jumpHost) return;
  options.useJump = true;
  options.jumpHost = jumpHost;
  options.jumpPort = firstPipeValue(portList) || "22";
  options.jumpUser = firstPipeValue(userList);
}

function firstPipeValue(value: string | undefined): string {
  return cleanText(mobaUnescape((value ?? "").split("__PIPE__")[0] ?? ""), MAX_NAME_LENGTH);
}

function mobaBasicToAuth(
  sessionType: string,
  basic: string[],
  homeDir: string | null,
): AuthMethod {
  const keyPath = sessionType === "SSH"
    ? mobaPrivateKeyPath(basic[14] ?? "", homeDir)
    : sessionType === "SFTP"
      ? mobaPrivateKeyPath(basic[9] ?? "", homeDir)
      : "";

  return keyPath ? { PrivateKey: { key_path: keyPath } } : sessionType === "SSH" || sessionType === "SFTP" ? "Password" : "None";
}

function mobaPrivateKeyPath(rawPath: string, homeDir: string | null): string {
  const path = cleanText(mobaUnescape(rawPath), MAX_PATH_LENGTH);
  if (!path) return "";
  const profileMacro = "_ProfileDir_";
  if (!path.toLowerCase().startsWith(profileMacro.toLowerCase())) return path;

  const home = cleanText(homeDir, MAX_PATH_LENGTH) || "~";
  return joinHomeRelativePath(home, path.slice(profileMacro.length));
}

function joinHomeRelativePath(homeDir: string, relativePath: string): string {
  const home = homeDir.trim().replace(/[\\/]+$/, "");
  if (!home) return cleanText(relativePath, MAX_PATH_LENGTH);
  const windows = /^[A-Za-z]:[\\/]/.test(home) || /^\\\\/.test(home);
  const sep = windows ? "\\" : "/";
  const relative = relativePath
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]+/g, sep);
  return cleanText(relative ? `${home}${sep}${relative}` : home, MAX_PATH_LENGTH);
}

function mobaSessionLine(
  session: SessionConfig,
  usedNames: Set<string>,
  warnings: string[],
): string | null {
  const exportType = MOBAXTERM_EXPORT_TYPES[session.session_type];
  if (!exportType) {
    warnings.push(`Skipped "${session.name}" because MobaXterm export does not support ${session.session_type}.`);
    return null;
  }

  const name = uniqueMobaName(session.name || session.host || session.session_type, usedNames, warnings);
  const basic = mobaBasicGroup(session, exportType.code, warnings);
  const terminal = mobaTerminalGroup(session);
  const comment = safeMobaComment(optionString(parseSessionOptions(session.options_json).description), warnings);
  return `${name}=#${exportType.icon}#${basic.join("%")}#${terminal}#0#${comment || " "}#-1`;
}

function mobaBasicGroup(
  session: SessionConfig,
  typeCode: string,
  warnings: string[],
): string[] {
  const options = parseSessionOptions(session.options_json);
  const host = safeMobaPercentField(session.host, "host", warnings);
  const port = String(sanitizePort(session.port, DEFAULT_PORTS[session.session_type] ?? 0));
  const username = safeMobaPercentField(session.username ?? "", "username", warnings);
  const privateKey = safeMobaPercentField(privateKeyPath(session.auth_method), "private key path", warnings);
  const jumpHost = safeMobaPercentField(optionString(options.jumpHost), "jump host", warnings);
  const jumpPort = safeMobaPercentField(optionString(options.jumpPort) || "22", "jump port", warnings);
  const jumpUser = safeMobaPercentField(optionString(options.jumpUser), "jump user", warnings);

  if (typeCode === "0") {
    const fields = [
      "0",
      host,
      port,
      username,
      "",
      options.x11 === false ? "0" : "-1",
      options.compression === true ? "-1" : "0",
      safeMobaPercentField(optionString(options.startupCmd), "startup command", warnings),
      jumpHost,
      jumpHost ? jumpPort : "",
      jumpHost ? jumpUser : "",
      options.doNotExit === true ? "-1" : "0",
      username ? "0" : "-1",
      "0",
      privateKey,
      "",
      "-1",
      "0",
      "0",
      "0",
      "",
      "1080",
      "",
      "0",
      "0",
      "1",
      "",
      "0",
      "",
      "",
      "",
      "0",
      "-1",
      "-1",
      "0",
    ];
    return fields;
  }

  if (typeCode === "7") {
    return [
      "7",
      host,
      port,
      username,
      "-1",
      options.compression === true ? "-1" : "0",
      "",
      "0",
      "0",
      privateKey,
      "0",
      "",
      "1080",
      "",
      "",
      "",
      "-1",
    ];
  }

  if (typeCode === "4") {
    return [
      "4",
      host,
      port,
      username,
      "0",
      "0",
      "0",
      "0",
      "-1",
      "0",
      "0",
      "-1",
      safeMobaPercentField(optionString(options.startupCmd), "startup command", warnings),
      jumpHost,
      jumpHost ? jumpPort : "",
      jumpHost ? jumpUser : "",
      "0",
      "0",
      "",
      "-1",
      "",
      "-1",
      "-1",
      "0",
      "-1",
      "0",
      "-1",
      "0",
      "0",
      "0",
      "0",
      "",
    ];
  }

  return [
    "5",
    host,
    port,
    "-1",
    "0",
    jumpHost,
    jumpHost ? jumpPort : "",
    jumpHost ? jumpUser : "",
    "",
    "-1",
    "0",
    "0",
    "",
    "0",
    "",
    "1080",
    "",
    "",
  ];
}

function mobaTerminalGroup(session: SessionConfig): string {
  const profile = sanitizeOptions(session.options_json).terminalProfile;
  const terminalProfile = isRecord(profile) ? profile : {};
  const fontFamily = safeTerminalFont(optionString(terminalProfile.fontFamily));
  const fontSize = sanitizeInteger(terminalProfile.fontSize, 10);
  return [
    fontFamily,
    String(Math.min(32, Math.max(8, fontSize))),
    "0",
    "0",
    "-1",
    "15",
    "236,236,236",
    "30,30,30",
    "180,180,192",
    "0",
    "-1",
    "0",
    "",
    "xterm",
    "-1",
    "0",
    "_Std_Colors_0_",
    "80",
    "24",
    "0",
    "1",
    "-1",
    "<none>",
    "",
    "0",
    "0",
    "-1",
    "-1",
  ].join("%");
}

function safeTerminalFont(value: string): string {
  const primary = value.split(",")[0]?.replace(/^["']|["']$/g, "").trim();
  return primary ? primary.replace(/[^\x20-\x7E]/g, "_").slice(0, 80) : "MobaFont";
}

function privateKeyPath(authMethod: AuthMethod): string {
  return typeof authMethod === "object" && "PrivateKey" in authMethod
    ? authMethod.PrivateKey.key_path
    : "";
}

function authMethodToPortable(authMethod: AuthMethod): PortableAuth {
  if (authMethod === "Password") return { kind: "password" };
  if (authMethod === "Agent") return { kind: "agent" };
  if (authMethod === "None") return { kind: "none" };
  return {
    kind: "private-key",
    private_key_path: cleanText(authMethod.PrivateKey.key_path, MAX_PATH_LENGTH),
  };
}

function portableAuthToAuthMethod(value: unknown): AuthMethod {
  if (!isRecord(value)) return "Password";
  if (value.kind === "private-key") {
    const keyPath = cleanText(firstString(value.private_key_path), MAX_PATH_LENGTH);
    return keyPath ? { PrivateKey: { key_path: keyPath } } : "Password";
  }
  if (value.kind === "agent") return "Agent";
  if (value.kind === "none") return "None";
  return "Password";
}

function sanitizeAuthMethod(value: unknown): AuthMethod {
  if (value === "Password" || value === "Agent" || value === "None") return value;
  if (isRecord(value) && isRecord(value.PrivateKey)) {
    const keyPath = cleanText(firstString(value.PrivateKey.key_path), MAX_PATH_LENGTH);
    return keyPath ? { PrivateKey: { key_path: keyPath } } : "Password";
  }
  return "Password";
}

function sanitizeOptions(input: unknown): Record<string, unknown> {
  const source = typeof input === "string" ? parseOptionsString(input) : input;
  if (!isRecord(source)) return {};

  const output: Record<string, unknown> = {};
  copyBoolean(source, output, "x11");
  copyBoolean(source, output, "compression");
  copyBoolean(source, output, "doNotExit");
  copyBoolean(source, output, "disableAiWrite");
  copyBoolean(source, output, "useJump");
  copyBoolean(source, output, "agentForward");
  copyString(source, output, "startupCmd", MAX_OPTION_LENGTH);
  copyString(source, output, "jumpHost", MAX_HOST_LENGTH);
  copyString(source, output, "jumpUser", MAX_NAME_LENGTH);
  copyString(source, output, "jumpPort", 16);
  copyString(source, output, "description", MAX_OPTION_LENGTH);
  copyString(source, output, "tags", MAX_OPTION_LENGTH);
  copyString(source, output, "localShellPath", MAX_PATH_LENGTH);
  copyStringArray(source, output, "localShellArgs", 64, MAX_OPTION_LENGTH);
  copyString(source, output, "passwordRef", MAX_OPTION_LENGTH);
  copyString(source, output, "dbCatalog", MAX_NAME_LENGTH);
  copyString(source, output, "dbDatabase", MAX_NAME_LENGTH);
  copyString(source, output, "dbTimeout", 16);
  copyString(source, output, "dbHttpPort", 16);
  copyString(source, output, "dbChProtocol", 16);
  copyString(source, output, "dbRedisIndex", 16);
  copyString(source, output, "hbaseNamespace", MAX_NAME_LENGTH);
  copyString(source, output, "hbaseRestPath", MAX_PATH_LENGTH);
  copyString(source, output, "proxyKind", 16);
  copyString(source, output, "testUrl", MAX_HOST_LENGTH);
  copyBoolean(source, output, "dbSsl");

  if ("terminalProfile" in source) {
    const profile = normalizeTerminalProfile(source.terminalProfile);
    delete profile.logPath;
    output.terminalProfile = profile;
  }

  return output;
}

function parseOptionsString(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function copyBoolean(source: Record<string, unknown>, output: Record<string, unknown>, key: string) {
  if (typeof source[key] === "boolean") output[key] = source[key];
}

function copyString(
  source: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
  maxLength: number,
) {
  const value = cleanText(firstString(source[key]), maxLength);
  if (value) output[key] = value;
}

function copyStringArray(
  source: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
  maxItems: number,
  maxItemLength: number,
) {
  const value = source[key];
  if (!Array.isArray(value)) return;
  const strings = value
    .map((item) => cleanText(firstString(item), maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
  if (strings.length > 0) output[key] = strings;
}

function sanitizeSessionType(value: unknown, warnings: string[]): string | null {
  const type = cleanText(firstString(value) || "SSH", 32);
  if (Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, type)) return type;
  warnings.push(`Skipped a session because type "${type || "(empty)"}" is not supported.`);
  return null;
}

function sanitizePort(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(65535, Math.max(0, Math.round(parsed)));
}

function sanitizeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function cleanText(value: unknown, maxLength: number): string {
  return firstString(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function optionalCleanText(value: unknown, maxLength: number): string | null {
  const cleaned = cleanText(value, maxLength);
  return cleaned || null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text = firstString(value).trim();
    if (text) return text;
  }
  return "";
}

function firstKnown(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      i += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function combineImportFolder(targetFolder: string | null, importedFolder: string | null): string | null {
  const target = normalizeGroupPath(targetFolder);
  const imported = normalizeGroupPath(importedFolder);
  if (target && imported) return `${target} / ${imported}`;
  return target ?? imported;
}

function relativeFolderPath(groupPath: string | null | undefined, scopeFolder: string | null): string | null {
  const group = normalizeGroupPath(groupPath);
  const scope = normalizeGroupPath(scopeFolder);
  if (!group) return null;
  if (!scope) return group;
  if (group === scope) return null;
  if (groupPathContains(scope, group)) return group.slice(scope.length + 3);
  return group;
}

function finalizeImportResult(
  sessions: SessionConfig[],
  skipped: number,
  warnings: string[],
  existingSessions: readonly SessionConfig[] | undefined,
  secrets: readonly SessionImportSecret[] = [],
  externalVault?: ExternalVaultPrompt,
  externalSecretsTool?: SessionImportResult["externalSecretsTool"],
): SessionImportResult {
  return {
    sessions: makeUniqueImportedSessions(sessions, existingSessions ?? []),
    warnings: uniqueWarnings(warnings),
    skipped,
    secrets: [...secrets],
    externalVault,
    externalSecretsTool,
  };
}

function makeUniqueImportedSessions(
  sessions: readonly SessionConfig[],
  existingSessions: readonly SessionConfig[],
): SessionConfig[] {
  const used = new Set<string>();
  for (const session of existingSessions) {
    used.add(nameKey(session.group_path, session.name));
  }

  return sessions.map((session) => {
    let name = session.name;
    let index = 2;
    while (used.has(nameKey(session.group_path, name))) {
      name = `${session.name} (${index})`;
      index += 1;
    }
    used.add(nameKey(session.group_path, name));
    return name === session.name ? session : { ...session, name };
  });
}

function nameKey(groupPath: string | null | undefined, name: string): string {
  return `${normalizeGroupPath(groupPath) ?? ""}\u0000${name.trim().toLowerCase()}`;
}

function uniqueWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings)];
}

function limitRows(rows: unknown[], warnings: string[]): { rows: unknown[]; skipped: number } {
  if (rows.length <= MAX_SESSIONS) return { rows, skipped: 0 };
  warnings.push(`Only the first ${MAX_SESSIONS} sessions were imported.`);
  return { rows: rows.slice(0, MAX_SESSIONS), skipped: rows.length - MAX_SESSIONS };
}

function assertImportSize(text: string, maxChars: number = MAX_IMPORT_CHARS) {
  if (text.length > maxChars) {
    throw new Error("The selected file is too large to import safely.");
  }
}

function resolveNow(value: number | undefined): number {
  return value ?? Math.floor(Date.now() / 1000);
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackIdCounter += 1;
  return `import-${Date.now()}-${fallbackIdCounter}`;
}

function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function decodeMobaXtermText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder("utf-8").decode(bytes.slice(3));
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const language = typeof navigator === "undefined" ? "" : navigator.language.toLowerCase();
    if (language.startsWith("zh")) {
      try {
        return new TextDecoder("gbk").decode(bytes);
      } catch {
        return new TextDecoder("windows-1252").decode(bytes);
      }
    }
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function mobaUnescape(value: string): string {
  return value
    .replace(/__PTVIRG__/g, ";")
    .replace(/__DBLQUO__/g, "\"")
    .replace(/__PIPE__/g, "|")
    .replace(/__DIEZE__/g, "#")
    .replace(/__PERCENT__/g, "%");
}

function mobaRootFolder(scopeFolder: string | null): string {
  const scope = normalizeGroupPath(scopeFolder);
  return scope ? leafGroupName(scope) : "";
}

function mobaFolderForSession(session: SessionConfig, scopeFolder: string | null): string {
  const scope = normalizeGroupPath(scopeFolder);
  const relative = relativeFolderPath(session.group_path, scopeFolder);
  if (!scope) return pathToMobaFolder(relative);
  const root = leafGroupName(scope);
  return relative ? pathToMobaFolder(`${root} / ${relative}`) : root;
}

function pathToMobaFolder(path: string | null): string {
  return normalizeGroupPath(path)?.replace(/\s*\/\s*/g, "\\") ?? "";
}

function ensureMobaSection(sectionMap: Map<string, SessionConfig[]>, folder: string) {
  const parts = folder.split("\\").filter(Boolean);
  if (parts.length === 0) {
    if (!sectionMap.has("")) sectionMap.set("", []);
    return;
  }
  for (let i = 1; i <= parts.length; i += 1) {
    const path = parts.slice(0, i).join("\\");
    if (!sectionMap.has(path)) sectionMap.set(path, []);
  }
}

function safeMobaPercentField(value: string, label: string, warnings: string[]): string {
  return safeMobaAscii(value, label, warnings)
    .replace(/%/g, "__PERCENT__")
    .replace(/;/g, "__PTVIRG__")
    .replace(/"/g, "__DBLQUO__")
    .replace(/\|/g, "__PIPE__")
    .replace(/#/g, "__DIEZE__")
    .replace(/\r?\n/g, " ");
}

function safeMobaComment(value: string, warnings: string[]): string {
  return safeMobaAscii(value, "comment", warnings)
    .replace(/#/g, "__DIEZE__")
    .replace(/%/g, " ")
    .replace(/\r?\n/g, " ");
}

function safeMobaIniValue(value: string, label: string, warnings: string[]): string {
  return safeMobaAscii(value, label, warnings)
    .replace(/[\r\n=[\]]/g, " ")
    .trim();
}

function uniqueMobaName(value: string, usedNames: Set<string>, warnings: string[]): string {
  const base = safeMobaIniValue(value, "session name", warnings) || "Session";
  let name = base;
  let index = 2;
  while (usedNames.has(name.toLowerCase())) {
    name = `${base} (${index})`;
    index += 1;
  }
  usedNames.add(name.toLowerCase());
  return name;
}

function safeMobaAscii(value: string, label: string, warnings: string[]): string {
  const cleaned = cleanText(value, MAX_OPTION_LENGTH);
  const safe = cleaned.replace(/[^\x20-\x7E]/g, "_");
  if (safe !== cleaned) {
    warnings.push(`Some ${label} characters are not supported by MobaXterm export and were replaced.`);
  }
  return safe;
}

function optionString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function slugify(value: string): string {
  return value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-") || "user-sessions";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
