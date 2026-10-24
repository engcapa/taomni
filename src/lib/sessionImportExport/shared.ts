import type { AuthMethod, SessionConfig } from "../ipc";
import { normalizeNetworkSettings } from "../networkSettings";
import { groupPathContains, normalizeGroupPath, toStoredGroupPath } from "../sessionPaths";
import { normalizeTerminalProfile } from "../terminalProfile";
import { type SessionImportSecret, type SecureCrtEncryptedPassword, type ExternalVaultPrompt, type SessionImportResult, MAX_HOST_LENGTH, MAX_NAME_LENGTH, DEFAULT_PORTS, MAX_PATH_LENGTH, type PortableAuth, MAX_OPTION_LENGTH, MAX_SESSIONS, MAX_IMPORT_CHARS } from "./model";


export let fallbackIdCounter = 0;


export function createSessionImportResult(
  sessions: readonly SessionConfig[],
  options: {
    existingSessions?: readonly SessionConfig[];
    warnings?: readonly string[];
    skipped?: number;
    secrets?: readonly SessionImportSecret[];
    secureCrtPasswords?: readonly SecureCrtEncryptedPassword[];
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
    options.secureCrtPasswords ?? [],
    options.externalVault,
    options.externalSecretsTool,
  );
}


/** True when the driver/URL key clearly identifies Trino (not PrestoDB). */
export function isTrinoDriverKey(value: string): boolean {
  return /\btrino\b/i.test(value);
}


export function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return {};
}


export interface ImportedSessionInput {
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


export function importedSession(input: ImportedSessionInput): SessionConfig | null {
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


export function protocolToSessionType(value: unknown, warnings: string[]): string {
  const protocol = cleanText(value, 32).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!protocol || protocol === "ssh" || protocol === "ssh2") return "SSH";
  if (protocol === "sftp") return "SFTP";
  if (protocol === "telnet") return "Telnet";
  if (protocol === "rlogin") return "Rlogin";
  if (protocol === "mosh") return "Mosh";
  if (protocol === "rdp" || protocol === "rdpfile") return "RDP";
  if (protocol === "vnc") return "VNC";
  if (protocol === "ftp") return "FTP";
  if (protocol === "serial") return "Serial";
  if (protocol === "browser") return "Browser";
  warnings.push(`Imported unsupported protocol "${String(value)}" as SSH.`);
  return "SSH";
}


export function privateKeyAuth(keyPath: string): AuthMethod | undefined {
  const cleaned = cleanText(keyPath, MAX_PATH_LENGTH);
  return cleaned ? { PrivateKey: { key_path: cleaned } } : undefined;
}


export function parseIniSections(text: string): Map<string, Map<string, string>> {
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


export function getIni(section: Map<string, string>, key: string): string {
  return section.get(key.toLowerCase()) ?? "";
}


export function normalizeImportPath(value: string): string {
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


export function parseSimpleScalar(value: string): string | number | boolean | unknown[] {
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


export function parsePlistDicts(text: string): Array<Record<string, unknown>> {
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


export function parseXmlElementAttributes(text: string): Array<Record<string, string>> {
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


export function parseXmlChildElementRecords(text: string): Array<Record<string, string>> {
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


export function firstXmlAttr(attrs: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = attrs[key.toLowerCase()];
    if (value) return value;
  }
  return "";
}


export function countNullBytes(bytes: Uint8Array): number {
  let count = 0;
  // Cap the scan for very large buffers; a representative sample is enough.
  const limit = Math.min(bytes.length, 4096);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) count += 1;
  }
  return bytes.length > limit ? Math.round((count / limit) * bytes.length) : count;
}


export function folderFromSourcePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  return normalizeGroupPath(parts.join(" / "));
}


export function nameFromSourcePath(path: string | null | undefined): string {
  if (!path) return "";
  const name = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return name.replace(/\.[^.]+$/, "");
}


export function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}


export function rowToSession(
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


export function authMethodToPortable(authMethod: AuthMethod): PortableAuth {
  if (authMethod === "Password") return { kind: "password" };
  if (authMethod === "Gssapi") return { kind: "gssapi" };
  if (authMethod === "Agent") return { kind: "agent" };
  if (authMethod === "None") return { kind: "none" };
  return {
    kind: "private-key",
    private_key_path: cleanText(authMethod.PrivateKey.key_path, MAX_PATH_LENGTH),
  };
}


export function portableAuthToAuthMethod(value: unknown): AuthMethod {
  if (!isRecord(value)) return "Password";
  if (value.kind === "private-key") {
    const keyPath = cleanText(firstString(value.private_key_path), MAX_PATH_LENGTH);
    return keyPath ? { PrivateKey: { key_path: keyPath } } : "Password";
  }
  if (value.kind === "gssapi") return "Gssapi";
  if (value.kind === "agent") return "Agent";
  if (value.kind === "none") return "None";
  return "Password";
}


export function sanitizeAuthMethod(value: unknown): AuthMethod {
  if (value === "Password" || value === "Agent" || value === "None") return value;
  if (isRecord(value) && isRecord(value.PrivateKey)) {
    const keyPath = cleanText(firstString(value.PrivateKey.key_path), MAX_PATH_LENGTH);
    return keyPath ? { PrivateKey: { key_path: keyPath } } : "Password";
  }
  return "Password";
}


export function sanitizeOptions(input: unknown): Record<string, unknown> {
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
  // "presto" | "trino" — selects X-Presto-* vs X-Trino-* HTTP headers.
  copyString(source, output, "dbPrestoDialect", 16);
  copyString(source, output, "dbRedisIndex", 16);
  copyString(source, output, "hbaseNamespace", MAX_NAME_LENGTH);
  copyString(source, output, "hbaseRestPath", MAX_PATH_LENGTH);
  copyString(source, output, "proxyKind", 16);
  copyString(source, output, "testUrl", MAX_HOST_LENGTH);
  copyBoolean(source, output, "dbSsl");

  if ("networkSettings" in source) {
    output.networkSettings = sanitizeNetworkSettings(source.networkSettings);
  }

  if ("terminalProfile" in source) {
    const profile = normalizeTerminalProfile(source.terminalProfile);
    delete profile.logPath;
    output.terminalProfile = profile;
  }

  return output;
}


export function sanitizeNetworkSettings(input: unknown): Record<string, unknown> {
  const settings = normalizeNetworkSettings(input);
  const proxyPass = safeVaultRef(settings.proxyPass);
  const jumpPassword = safeVaultRef(settings.jumpPassword);
  return {
    proxyKind: safeProxyKind(settings.proxyKind),
    proxyHost: cleanText(settings.proxyHost, MAX_HOST_LENGTH),
    proxyPort: cleanText(settings.proxyPort, 16),
    proxyUser: cleanText(settings.proxyUser, MAX_NAME_LENGTH),
    proxyPass,
    proxySaveAuth: Boolean(proxyPass),
    proxySessionId: cleanText(settings.proxySessionId, MAX_OPTION_LENGTH),
    keepAlive: settings.keepAlive,
    keepAliveIntervalSecs: cleanText(settings.keepAliveIntervalSecs, 16),
    tcpNodelay: settings.tcpNodelay,
    disableNagle: settings.disableNagle,
    ipVersion: safeIpVersion(settings.ipVersion),
    localForwards: settings.localForwards
      .map((forward) => ({
        id: cleanText(forward.id, MAX_OPTION_LENGTH),
        local: cleanText(forward.local, MAX_OPTION_LENGTH),
        remote: cleanText(forward.remote, MAX_OPTION_LENGTH),
        desc: cleanText(forward.desc, MAX_OPTION_LENGTH),
      }))
      .filter((forward) => forward.local && forward.remote)
      .slice(0, 128),
    jumpSessionId: cleanText(settings.jumpSessionId, MAX_OPTION_LENGTH),
    jumpHost: cleanText(settings.jumpHost, MAX_HOST_LENGTH),
    jumpPort: cleanText(settings.jumpPort, 16) || "22",
    jumpUser: cleanText(settings.jumpUser, MAX_NAME_LENGTH),
    jumpAuthKind: settings.jumpAuthKind,
    jumpPassword,
    jumpKeyPath: cleanText(settings.jumpKeyPath, MAX_PATH_LENGTH),
    jumpSaveAuth: Boolean(jumpPassword),
  };
}


export function safeVaultRef(value: unknown): string {
  const cleaned = cleanText(value, MAX_OPTION_LENGTH);
  return cleaned.startsWith("vault:") ? cleaned : "";
}


export function safeProxyKind(value: string): string {
  return ["none", "http", "socks5", "ssh-tunnel", "system"].includes(value) ? value : "none";
}


export function safeIpVersion(value: string): string {
  return ["auto", "ipv4", "ipv6"].includes(value) ? value : "auto";
}


export function parseOptionsString(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}


export function copyBoolean(source: Record<string, unknown>, output: Record<string, unknown>, key: string) {
  if (typeof source[key] === "boolean") output[key] = source[key];
}


export function copyString(
  source: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
  maxLength: number,
) {
  const value = cleanText(firstString(source[key]), maxLength);
  if (value) output[key] = value;
}


export function copyStringArray(
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


export function sanitizeSessionType(value: unknown, warnings: string[]): string | null {
  const type = cleanText(firstString(value) || "SSH", 32);
  if (Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, type)) return type;
  warnings.push(`Skipped a session because type "${type || "(empty)"}" is not supported.`);
  return null;
}


export function sanitizePort(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(65535, Math.max(0, Math.round(parsed)));
}


export function sanitizeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}


export function cleanText(value: unknown, maxLength: number): string {
  return firstString(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLength);
}


export function optionalCleanText(value: unknown, maxLength: number): string | null {
  const cleaned = cleanText(value, maxLength);
  return cleaned || null;
}


export function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}


export function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text = firstString(value).trim();
    if (text) return text;
  }
  return "";
}


export function firstKnown(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}


export function combineImportFolder(targetFolder: string | null, importedFolder: string | null): string | null {
  const target = normalizeGroupPath(targetFolder);
  const imported = normalizeGroupPath(importedFolder);
  if (target && imported) return `${target} / ${imported}`;
  return target ?? imported;
}


export function relativeFolderPath(groupPath: string | null | undefined, scopeFolder: string | null): string | null {
  const group = normalizeGroupPath(groupPath);
  const scope = normalizeGroupPath(scopeFolder);
  if (!group) return null;
  if (!scope) return group;
  if (group === scope) return null;
  if (groupPathContains(scope, group)) return group.slice(scope.length + 3);
  return group;
}


export function finalizeImportResult(
  sessions: SessionConfig[],
  skipped: number,
  warnings: string[],
  existingSessions: readonly SessionConfig[] | undefined,
  secrets: readonly SessionImportSecret[] = [],
  secureCrtPasswords: readonly SecureCrtEncryptedPassword[] = [],
  externalVault?: ExternalVaultPrompt,
  externalSecretsTool?: SessionImportResult["externalSecretsTool"],
): SessionImportResult {
  return {
    sessions: makeUniqueImportedSessions(sessions, existingSessions ?? []),
    warnings: uniqueWarnings(warnings),
    skipped,
    secrets: [...secrets],
    secureCrtPasswords: [...secureCrtPasswords],
    externalVault,
    externalSecretsTool,
  };
}


export function makeUniqueImportedSessions(
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


export function nameKey(groupPath: string | null | undefined, name: string): string {
  return `${normalizeGroupPath(groupPath) ?? ""}\u0000${name.trim().toLowerCase()}`;
}


export function uniqueWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings)];
}


export function limitRows(rows: unknown[], warnings: string[]): { rows: unknown[]; skipped: number } {
  if (rows.length <= MAX_SESSIONS) return { rows, skipped: 0 };
  warnings.push(`Only the first ${MAX_SESSIONS} sessions were imported.`);
  return { rows: rows.slice(0, MAX_SESSIONS), skipped: rows.length - MAX_SESSIONS };
}


export function assertImportSize(text: string, maxChars: number = MAX_IMPORT_CHARS) {
  if (text.length > maxChars) {
    throw new Error("The selected file is too large to import safely.");
  }
}


export function resolveNow(value: number | undefined): number {
  return value ?? Math.floor(Date.now() / 1000);
}


export function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackIdCounter += 1;
  return `import-${Date.now()}-${fallbackIdCounter}`;
}


export function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}


export function slugify(value: string): string {
  return value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-") || "user-sessions";
}


export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function splitFlowItems(value: string): string[] {
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

export function privateKeyPath(authMethod: AuthMethod): string {
  return typeof authMethod === "object" && "PrivateKey" in authMethod
    ? authMethod.PrivateKey.key_path
    : "";
}

export function optionString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
