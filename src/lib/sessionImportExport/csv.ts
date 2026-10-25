import type { AuthMethod, SessionConfig } from "../ipc";
import { normalizeNetworkSettings } from "../networkSettings";
import { normalizeGroupPath } from "../sessionPaths";
import { parseSessionOptions } from "../terminalProfile";
import { type SessionImportOptions, type SessionImportResult, MAX_SESSIONS, type SessionExportResult, MAX_NAME_LENGTH, MAX_HOST_LENGTH, DEFAULT_PORTS, type SessionImportSecret, MAX_PATH_LENGTH, MAX_OPTION_LENGTH } from "./model";
import { assertImportSize, resolveNow, finalizeImportResult, sanitizeSessionType, cleanText, sanitizePort, optionalCleanText, relativeFolderPath, slugify, uniqueWarnings, combineImportFolder, importedSession, privateKeyAuth, optionString, privateKeyPath } from "./shared";


export const CSV_SESSION_HEADERS = [
  "name",
  "session_type",
  "host",
  "port",
  "username",
  "auth_method",
  "private_key_path",
  "password",
  "group_path",
  "description",
  "tags",
  "startup_cmd",
  "jump_host",
  "jump_port",
  "jump_user",
  "jump_key_path",
  "compression",
  "x11",
  "agent_forward",
];


export const CSV_PASSWORD_SESSION_TYPES = new Set([
  "SSH",
  "SFTP",
  "RDP",
  "VNC",
  "FTP",
  "Telnet",
  "Rlogin",
  "Mosh",
  "MySQL",
  "PostgreSQL",
  "PanWeiDB",
  "Oracle",
  "SQLServer",
  "StarRocks",
  "ClickHouse",
  "Presto",
  "Redis",
  "HBaseShell",
  "Proxy",
  "Mail",
]);


export function parseCsvSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new Error("The selected CSV file is empty.");
  }

  const headers = rows[0].map(normalizeCsvHeader);
  const hasHeader = ["name", "session_type", "type", "host", "hostname", "ip", "address"].some((key) => headers.includes(key));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const now = resolveNow(options.now);
  const parsedRows = dataRows
    .filter((row) => row.some((cell) => cell.trim()))
    .slice(0, MAX_SESSIONS)
    .map((row) => csvRowToSession(row, hasHeader ? headers : null, options.targetFolder ?? null, now, warnings))
    .filter((parsed): parsed is CsvSessionImport => parsed !== null);

  const skipped = dataRows.length - parsedRows.length;
  return finalizeImportResult(
    parsedRows.map((parsed) => parsed.session),
    skipped,
    warnings,
    options.existingSessions,
    parsedRows.flatMap((parsed) => parsed.secrets),
  );
}


export function serializeCsvSessions(
  sessions: readonly SessionConfig[],
  scopeFolder: string | null,
): SessionExportResult {
  const warnings: string[] = [];
  const rows = [CSV_SESSION_HEADERS];

  for (const session of sessions) {
    const sessionType = sanitizeSessionType(session.session_type, warnings);
    if (!sessionType) continue;
    const options = parseSessionOptions(session.options_json);
    const networkSettings = normalizeNetworkSettings(options.networkSettings);
    const jumpHost = optionString(options.jumpHost) || networkSettings.jumpHost;
    const jumpPort = optionString(options.jumpPort) || networkSettings.jumpPort;
    const jumpUser = optionString(options.jumpUser) || networkSettings.jumpUser;
    const jumpKeyPath = networkSettings.jumpKeyPath;
    rows.push([
      cleanText(session.name, MAX_NAME_LENGTH),
      sessionType,
      cleanText(session.host, MAX_HOST_LENGTH),
      String(sanitizePort(session.port, DEFAULT_PORTS[sessionType] ?? 0)),
      optionalCleanText(session.username, MAX_NAME_LENGTH) ?? "",
      authMethodToCsv(session.auth_method),
      privateKeyPath(session.auth_method),
      "",
      relativeFolderPath(session.group_path, scopeFolder) ?? "",
      optionString(options.description),
      optionString(options.tags),
      optionString(options.startupCmd),
      jumpHost,
      jumpPort && jumpHost ? jumpPort : "",
      jumpHost ? jumpUser : "",
      jumpHost ? jumpKeyPath : "",
      csvBooleanValue(options.compression),
      csvBooleanValue(options.x11),
      csvBooleanValue(options.agentForward),
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


export function serializeCsvSessionTemplate(): SessionExportResult {
  return {
    filename: "taomni-ssh-session-import-template.csv",
    text: `${CSV_SESSION_HEADERS.map(csvEscape).join(",")}\r\n`,
    mimeType: "text/csv",
    warnings: [],
    skipped: 0,
  };
}


export interface CsvSessionImport {
  session: SessionConfig;
  secrets: SessionImportSecret[];
}


export function csvRowToSession(
  row: string[],
  headers: string[] | null,
  targetFolder: string | null,
  now: number,
  warnings: string[],
): CsvSessionImport | null {
  const get = (names: string | string[], index: number) => {
    if (!headers) return index >= 0 ? row[index] ?? "" : "";
    const aliases = Array.isArray(names) ? names : [names];
    for (const name of aliases) {
      const headerIndex = headers.indexOf(name);
      if (headerIndex >= 0) return row[headerIndex] ?? "";
    }
    return "";
  };

  const typeValue = get(["session_type", "type", "protocol"], 1) || "SSH";
  const sessionType = sanitizeSessionType(typeValue, warnings);
  if (!sessionType) return null;

  const host = cleanText(get(["host", "hostname", "ip", "address"], 2), MAX_HOST_LENGTH);
  if (sessionType !== "LocalShell" && sessionType !== "Serial" && !host) {
    warnings.push("Skipped a CSV row because host is empty.");
    return null;
  }

  const name = cleanText(get("name", 0), MAX_NAME_LENGTH) || host || sessionType;
  const username = optionalCleanText(get(["username", "user", "login"], 4), MAX_NAME_LENGTH);
  const importedFolder = normalizeGroupPath(get(["group_path", "folder_path", "folder", "group"], 5));
  const groupPath = combineImportFolder(targetFolder, importedFolder);
  const privateKey = cleanText(
    get(["private_key_path", "key_path", "identity_file", "identityfile", "private_key", "privatekey"], -1),
    MAX_PATH_LENGTH,
  );
  const password = cleanText(get(["password", "login_password", "ssh_password"], -1), MAX_OPTION_LENGTH);
  const authMethod = csvAuthMethod(get(["auth_method", "auth", "authentication"], -1), privateKey, sessionType, warnings);
  const options = csvOptions(get);

  const session = importedSession({
    sessionType,
    name,
    groupPath,
    host,
    port: get("port", 3),
    username,
    authMethod,
    options,
    now,
    warnings,
  });
  if (!session) return null;

  return {
    session,
    secrets: csvPasswordSecrets(session, password, privateKey, warnings),
  };
}


export function csvPasswordSecrets(
  session: SessionConfig,
  password: string,
  privateKey: string,
  warnings: string[],
): SessionImportSecret[] {
  if (!password) return [];

  if (!CSV_PASSWORD_SESSION_TYPES.has(session.session_type)) {
    warnings.push(`Skipped password for "${session.name}" because ${session.session_type} sessions do not support saved passwords.`);
    return [];
  }

  if ((session.session_type === "SSH" || session.session_type === "SFTP") && privateKey) {
    warnings.push(`Skipped password for "${session.name}" because the CSV row uses private-key authentication.`);
    return [];
  }

  if ((session.session_type === "SSH" || session.session_type === "SFTP") && session.auth_method !== "Password") {
    warnings.push(`Skipped password for "${session.name}" because auth_method is not password.`);
    return [];
  }

  return [{
    sessionId: session.id,
    kind: "password",
    label: `${session.username ?? "user"}@${session.host}:${session.port}`,
    value: password,
  }];
}


export function csvOptions(get: (names: string | string[], index: number) => string): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const description = cleanText(get("description", -1), MAX_OPTION_LENGTH);
  const tags = cleanText(get("tags", -1), MAX_OPTION_LENGTH);
  const startupCmd = cleanText(get(["startup_cmd", "startup_command", "command"], -1), MAX_OPTION_LENGTH);
  const jumpHost = cleanText(get(["jump_host", "bastion_host", "gateway_host"], -1), MAX_HOST_LENGTH);
  const jumpPort = cleanText(get(["jump_port", "bastion_port", "gateway_port"], -1), 16) || "22";
  const jumpUser = cleanText(get(["jump_user", "bastion_user", "gateway_user"], -1), MAX_NAME_LENGTH);
  const jumpKeyPath = cleanText(get(["jump_key_path", "jump_private_key_path", "bastion_key_path"], -1), MAX_PATH_LENGTH);
  const compression = csvBoolean(get("compression", -1));
  const x11 = csvBoolean(get("x11", -1));
  const agentForward = csvBoolean(get(["agent_forward", "agentforward"], -1));

  if (description) options.description = description;
  if (tags) options.tags = tags;
  if (startupCmd) options.startupCmd = startupCmd;
  if (typeof compression === "boolean") options.compression = compression;
  if (typeof x11 === "boolean") options.x11 = x11;
  if (typeof agentForward === "boolean") options.agentForward = agentForward;

  if (jumpHost) {
    options.useJump = true;
    options.jumpHost = jumpHost;
    options.jumpPort = jumpPort;
    options.jumpUser = jumpUser;
    options.networkSettings = {
      proxyKind: "ssh-tunnel",
      jumpSessionId: "",
      jumpHost,
      jumpPort,
      jumpUser,
      jumpAuthKind: jumpKeyPath ? "PrivateKey" : "Password",
      jumpKeyPath,
    };
  }

  return options;
}


export function csvAuthMethod(
  authValue: string,
  privateKey: string,
  sessionType: string,
  warnings: string[],
): AuthMethod | undefined {
  const supportsSshAuth = sessionType === "SSH" || sessionType === "SFTP";
  if (!supportsSshAuth) return undefined;
  if (privateKey) return privateKeyAuth(privateKey);

  const normalized = cleanText(authValue, 32).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return undefined;
  if (normalized === "password" || normalized === "pass") return "Password";
  if (normalized === "gssapi" || normalized === "kerberos") return "Gssapi";
  if (normalized === "agent" || normalized === "sshagent") return "Agent";
  if (normalized === "none" || normalized === "noauth") return "None";
  if (normalized === "privatekey" || normalized === "publickey" || normalized === "key") {
    warnings.push("A CSV row uses private-key authentication but private_key_path is empty; password authentication will be used.");
    return undefined;
  }
  warnings.push(`CSV auth_method "${authValue}" is not supported; password authentication will be used.`);
  return undefined;
}


export function normalizeCsvHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}


export function csvBoolean(value: string): boolean | undefined {
  const normalized = cleanText(value, 16).toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}


export function csvBooleanValue(value: unknown): string {
  return typeof value === "boolean" ? String(value) : "";
}


export function authMethodToCsv(authMethod: AuthMethod): string {
  if (authMethod === "Password") return "password";
  if (authMethod === "Gssapi") return "gssapi";
  if (authMethod === "Agent") return "agent";
  if (authMethod === "None") return "none";
  return "private-key";
}


export function parseCsv(text: string): string[][] {
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


export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}
