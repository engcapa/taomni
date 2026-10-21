import type { DbeaverCredentialEntry, SessionConfig } from "../ipc";
import { normalizeGroupPath } from "../sessionPaths";
import { type SessionImportOptions, type SessionImportResult, type SessionImportSecret, MAX_NAME_LENGTH, MAX_HOST_LENGTH, DEFAULT_PORTS, MAX_OPTION_LENGTH, MAX_PATH_LENGTH } from "./model";
import { assertImportSize, resolveNow, limitRows, finalizeImportResult, parseXmlElementAttributes, firstXmlAttr, optionalCleanText, cleanText, combineImportFolder, importedSession, firstKnown, sanitizePort, isTrinoDriverKey, firstString, isRecord, firstNonEmptyString, firstRecord, sanitizeOptions } from "./shared";


export interface DbeaverConnectionInput {
  id: string;
  record: Record<string, unknown>;
  folderPath: string | null;
}


export interface DbeaverUrlInfo {
  driverKey?: string;
  host?: string;
  port?: number;
  database?: string;
  catalog?: string;
  schema?: string;
  username?: string;
  password?: string;
  redisDbIndex?: string;
  ssl?: boolean;
}


export interface NavicatConnectionInput {
  attrs: Record<string, string>;
  folderPath: string | null;
}


export function parseDbeaverSessions(text: string, options: SessionImportOptions = {}): SessionImportResult {
  assertImportSize(text);

  const warnings: string[] = [];
  const now = resolveNow(options.now);
  const inputs = extractDbeaverConnections(text, warnings);
  const limited = limitRows(inputs, warnings);
  const sessions: SessionConfig[] = [];
  const secrets: SessionImportSecret[] = [];
  let skipped = limited.skipped;

  for (const input of limited.rows as DbeaverConnectionInput[]) {
    const imported = dbeaverConnectionToSession(
      input,
      options.targetFolder ?? null,
      now,
      warnings,
      options.dbeaverCredentials?.[input.id],
      options.dbeaverCredentials !== undefined,
    );
    if (!imported) {
      skipped += 1;
      continue;
    }
    sessions.push(imported.session);
    if (imported.password) {
      secrets.push({
        sessionId: imported.session.id,
        kind: "password",
        label: `${imported.session.name} (${imported.session.host}:${imported.session.port})`,
        value: imported.password,
      });
    }
  }

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions, secrets);
}


export async function parseNavicatSessions(text: string, options: SessionImportOptions = {}): Promise<SessionImportResult> {
  assertImportSize(text);

  const warnings: string[] = [];
  const now = resolveNow(options.now);
  const inputs = extractNavicatConnections(text, warnings);
  const limited = limitRows(inputs, warnings);
  const sessions: SessionConfig[] = [];
  const secrets: SessionImportSecret[] = [];
  let skipped = limited.skipped;

  for (const input of limited.rows as NavicatConnectionInput[]) {
    const imported = navicatConnectionToSession(input, options.targetFolder ?? null, now, warnings);
    if (!imported) {
      skipped += 1;
      continue;
    }
    sessions.push(imported.session);

    const password = await decryptNavicatPassword(input.attrs, imported.session.name, warnings);
    if (password) {
      secrets.push({
        sessionId: imported.session.id,
        kind: "password",
        label: `${imported.session.name} (${imported.session.host}:${imported.session.port})`,
        value: password,
        attachment: "session",
      });
    }
  }

  return finalizeImportResult(sessions, skipped, warnings, options.existingSessions, secrets);
}


export function extractDbeaverConnections(text: string, warnings: string[]): DbeaverConnectionInput[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    const out = extractDbeaverJsonConnections(parsed);
    if (out.length > 0) return out;
    warnings.push("No DBeaver connections were found in the selected JSON file.");
    return [];
  } catch {
    const out = extractDbeaverXmlConnections(text);
    if (out.length > 0) return out;
    throw new Error("The selected DBeaver file is not valid data-sources JSON or XML.");
  }
}


export function extractNavicatConnections(text: string, warnings: string[]): NavicatConnectionInput[] {
  const domRows = extractNavicatConnectionsFromDom(text);
  if (domRows.length > 0) return domRows;

  const rows = parseXmlElementAttributes(text)
    .filter(looksLikeNavicatConnection)
    .map((attrs) => ({
      attrs,
      folderPath: normalizeGroupPath(firstXmlAttr(attrs, ["folder", "folderPath", "group", "groupName", "path"])),
    }));
  if (rows.length > 0) return rows;
  warnings.push("No Navicat connections were found in the selected .ncx file.");
  return [];
}


export function extractNavicatConnectionsFromDom(text: string): NavicatConnectionInput[] {
  if (typeof DOMParser === "undefined") return [];

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "application/xml");
  } catch {
    return [];
  }
  if (doc.querySelector("parsererror")) return [];

  const rows: NavicatConnectionInput[] = [];
  const walk = (element: Element, folders: string[]) => {
    const attrs = navicatAttrsFromElement(element);
    const tag = element.tagName.toLowerCase();
    const folderName = navicatFolderName(tag, attrs);
    const nextFolders = folderName ? [...folders, folderName] : folders;

    if (looksLikeNavicatConnection(attrs)) {
      rows.push({
        attrs,
        folderPath: normalizeGroupPath(firstXmlAttr(attrs, ["folder", "folderPath", "group", "groupName", "path"]))
          ?? normalizeGroupPath(folders.join(" / ")),
      });
    }

    for (const child of Array.from(element.children)) {
      walk(child, nextFolders);
    }
  };

  for (const child of Array.from(doc.children)) {
    walk(child, []);
  }
  return rows;
}


export function navicatAttrsFromElement(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    attrs[attr.name.toLowerCase()] = attr.value;
  }

  for (const child of Array.from(element.children)) {
    if (child.children.length > 0) continue;
    const value = child.textContent?.trim() ?? "";
    if (value) attrs[child.tagName.toLowerCase()] = value;
  }
  return attrs;
}


export function navicatFolderName(tag: string, attrs: Record<string, string>): string | null {
  if (!/(folder|group|category)/i.test(tag) || looksLikeNavicatConnection(attrs)) return null;
  return optionalCleanText(firstXmlAttr(attrs, ["name", "label", "caption", "folderName", "groupName"]), MAX_NAME_LENGTH);
}


export function looksLikeNavicatConnection(attrs: Record<string, string>): boolean {
  return Boolean(
    firstXmlAttr(attrs, ["connType", "connectionType", "type", "driver", "dbType", "dbms"]) &&
      firstXmlAttr(attrs, ["host", "hostname", "server", "serverHost", "address", "ipAddress"]),
  );
}


export function navicatConnectionToSession(
  input: NavicatConnectionInput,
  targetFolder: string | null,
  now: number,
  warnings: string[],
): { session: SessionConfig } | null {
  const attrs = input.attrs;
  const label = cleanText(firstXmlAttr(attrs, ["connectionName", "name", "title", "caption"]), MAX_NAME_LENGTH) || "Navicat connection";
  const sessionType = navicatSessionType(firstXmlAttr(attrs, ["connType", "connectionType", "type", "driver", "dbType", "dbms"]));
  if (!sessionType) {
    warnings.push(`Skipped Navicat connection "${label}" because its database type is not supported by Taomni.`);
    return null;
  }

  const host = cleanText(firstXmlAttr(attrs, ["host", "hostname", "server", "serverHost", "address", "ipAddress"]), MAX_HOST_LENGTH);
  if (!host) {
    warnings.push(`Skipped Navicat connection "${label}" because host is empty.`);
    return null;
  }

  const database = cleanText(firstXmlAttr(attrs, ["database", "databaseName", "dbName", "initialDatabase", "schema"]), MAX_NAME_LENGTH);
  const catalog = cleanText(firstXmlAttr(attrs, ["catalog", "catalogName"]), MAX_NAME_LENGTH);
  const redisDbIndex = cleanText(firstXmlAttr(attrs, ["db", "dbIndex", "database"]), 16);
  const ssl = navicatTruthy(firstXmlAttr(attrs, ["ssl", "useSsl", "useSSL", "encrypt", "useEncryption", "sslMode"]));
  const importedFolder = combineImportFolder("Navicat", normalizeGroupPath(input.folderPath));

  const navicatDriverKey = firstXmlAttr(attrs, ["dbtype", "dbType", "connType", "type", "protocol", "driver"]) || "";
  const session = importedSession({
    name: label,
    sessionType,
    host,
    port: firstKnown(firstXmlAttr(attrs, ["port", "serverPort"]), DEFAULT_PORTS[sessionType] ?? 0),
    username: optionalCleanText(firstXmlAttr(attrs, ["userName", "username", "user", "userId", "userid"]), MAX_NAME_LENGTH),
    groupPath: combineImportFolder(targetFolder, importedFolder),
    authMethod: "Password",
    options: {
      description: "Imported from Navicat .ncx",
      dbDatabase: sessionType === "Redis" ? "" : database,
      dbCatalog: sessionType === "Presto" ? catalog : "",
      dbSsl: ssl,
      dbTimeout: "15",
      dbHttpPort: sessionType === "ClickHouse" ? String(sanitizePort(firstXmlAttr(attrs, ["httpPort", "http_port"]), 8123)) : "",
      dbChProtocol: sessionType === "ClickHouse" ? "HTTP" : "",
      dbPrestoDialect:
        sessionType === "Presto"
          ? (isTrinoDriverKey(navicatDriverKey) ? "trino" : "presto")
          : "",
      dbRedisIndex: sessionType === "Redis" ? redisDbIndex || database || "0" : "",
    },
    now,
    warnings,
  });
  return session ? { session } : null;
}


export function navicatSessionType(value: string): string | null {
  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(starrocks|starrocksdb|star rocks)\b/.test(key)) return "StarRocks";
  if (/\b(mysql|mariadb|tidb|oceanbase|polardb)\b/.test(key)) return "MySQL";
  if (/\b(panwei|panweidb|open gauss|opengauss)\b/.test(key)) return "PanWeiDB";
  if (/\b(oracle|oracledb|oci)\b/.test(key)) return "Oracle";
  if (/\b(postgresql|postgres|pgsql)\b/.test(key)) return "PostgreSQL";
  if (/\b(sqlserver|sql server|mssql|azure sql)\b/.test(key)) return "SQLServer";
  if (/\b(clickhouse|click house)\b/.test(key)) return "ClickHouse";
  if (/\b(presto|trino)\b/.test(key)) return "Presto";
  if (/\b(redis|valkey)\b/.test(key)) return "Redis";
  return null;
}


export async function decryptNavicatPassword(
  attrs: Record<string, string>,
  label: string,
  warnings: string[],
): Promise<string | null> {
  const encrypted = firstXmlAttr(attrs, ["password", "pwd", "encryptedPassword"]);
  if (!encrypted) {
    if (firstXmlAttr(attrs, ["pwd_2", "password_2", "password2"])) {
      warnings.push(`Navicat connection "${label}" uses the newer Pwd_2 credential format; local config password recovery is planned for phase 2.`);
    }
    return null;
  }

  try {
    return await decryptNavicatNcxPassword(encrypted);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`Could not decrypt saved password for Navicat connection "${label}": ${reason}`);
    return null;
  }
}


export const NAVICAT_NCX_KEY = bytesToArrayBuffer(new TextEncoder().encode("libcckeylibcckey"));

export const NAVICAT_NCX_IV = bytesToArrayBuffer(new TextEncoder().encode("libcciv libcciv "));


export async function decryptNavicatNcxPassword(value: string): Promise<string> {
  const ciphertext = hexToBytes(value);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto AES-CBC support is unavailable");
  }
  const key = await subtle.importKey("raw", NAVICAT_NCX_KEY, "AES-CBC", false, ["decrypt"]);
  const plaintext = await subtle.decrypt({ name: "AES-CBC", iv: NAVICAT_NCX_IV }, key, bytesToArrayBuffer(ciphertext));
  return new TextDecoder().decode(plaintext).replace(/\u0000+$/g, "");
}


export function hexToBytes(value: string): Uint8Array {
  const hex = value.trim();
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("unsupported Navicat password ciphertext");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}


export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}


export function navicatTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return /^(true|yes|1|required|verify-ca|verify-full|enabled|enable|on)$/i.test(firstString(value).trim());
}


export function extractDbeaverJsonConnections(parsed: unknown): DbeaverConnectionInput[] {
  const out: DbeaverConnectionInput[] = [];
  const seen = new WeakSet<object>();
  const rootFolders = isRecord(parsed) ? dbeaverFolderLookup(parsed) : new Map<string, string>();

  const visit = (value: unknown, folderLookup: Map<string, string>, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, folderLookup, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    if (seen.has(value)) return;
    seen.add(value);

    const localFolders = dbeaverFolderLookup(value);
    const folders = localFolders.size > 0 ? localFolders : folderLookup;
    const connections = value.connections ?? value.dataSources ?? value.datasources ?? value["data-sources"];
    if (isRecord(connections)) {
      for (const [id, connection] of Object.entries(connections)) {
        if (!isRecord(connection)) continue;
        out.push({
          id,
          record: connection,
          folderPath: dbeaverFolderPath(connection.folder ?? connection.folderId, folders),
        });
      }
    } else if (Array.isArray(connections)) {
      for (const connection of connections) {
        if (!isRecord(connection)) continue;
        out.push({
          id: cleanText(firstNonEmptyString(connection.id, connection.name), MAX_NAME_LENGTH),
          record: connection,
          folderPath: dbeaverFolderPath(connection.folder ?? connection.folderId, folders),
        });
      }
    } else if (looksLikeDbeaverConnection(value)) {
      out.push({
        id: cleanText(firstNonEmptyString(value.id, value.name), MAX_NAME_LENGTH),
        record: value,
        folderPath: dbeaverFolderPath(value.folder ?? value.folderId, folders),
      });
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "connections" || key === "folders") continue;
      visit(child, folders, depth + 1);
    }
  };

  visit(parsed, rootFolders, 0);
  return out;
}


export function extractDbeaverXmlConnections(text: string): DbeaverConnectionInput[] {
  return parseXmlElementAttributes(text)
    .filter((attrs) => looksLikeDbeaverConnection(attrs))
    .map((attrs, index) => ({
      id: attrs.id || `xml-${index}`,
      record: attrs,
      folderPath: normalizeGroupPath(firstNonEmptyString(attrs.folder, attrs.group, attrs.path)),
    }));
}


export function dbeaverConnectionToSession(
  input: DbeaverConnectionInput,
  targetFolder: string | null,
  now: number,
  warnings: string[],
  credential: DbeaverCredentialEntry | null | undefined,
  credentialsLoaded: boolean,
): { session: SessionConfig; password?: string } | null {
  const record = input.record;
  const configuration = firstRecord(record.configuration, record.connection, record.config, record);
  const properties = firstRecord(configuration.properties, record.properties);
  const authProperties = firstRecord(
    configuration["auth-properties"],
    configuration.authProperties,
    record["auth-properties"],
    record.authProperties,
  );
  const credentialSection = firstRecord(credential?.sections?.["#connection"]);
  const url = cleanText(firstNonEmptyString(
    configuration.url,
    configuration.jdbcUrl,
    configuration.jdbc_url,
    record.url,
    record.jdbcUrl,
  ), MAX_OPTION_LENGTH);
  const urlInfo = parseDbeaverJdbcUrl(url);
  const driverKey = [
    record.provider,
    record.driver,
    record.driverId,
    record.driver_id,
    record.type,
    configuration.provider,
    configuration.driver,
    configuration.driverId,
    urlInfo.driverKey,
    url,
  ].map((value) => firstString(value)).join(" ");
  const sessionType = dbeaverSessionType(driverKey);
  const label = cleanText(firstNonEmptyString(record.name, configuration.name, input.id, url), MAX_NAME_LENGTH) || "DBeaver connection";
  if (!sessionType) {
    warnings.push(`Skipped DBeaver connection "${label}" because its driver is not supported by Taomni.`);
    return null;
  }

  const host = cleanText(firstNonEmptyString(
    configuration.host,
    configuration.hostname,
    configuration.server,
    configuration.serverHost,
    configuration["server.host"],
    record.host,
    urlInfo.host,
  ), MAX_HOST_LENGTH);
  if (!host) {
    warnings.push(`Skipped DBeaver connection "${label}" because host is empty.`);
    return null;
  }

  const parsedPort = firstKnown(configuration.port, record.port, urlInfo.port);
  const port = sessionType === "ClickHouse"
    ? DEFAULT_PORTS.ClickHouse
    : sanitizePort(parsedPort, DEFAULT_PORTS[sessionType] ?? 0);
  const database = cleanText(firstNonEmptyString(
    configuration.database,
    configuration.databaseName,
    configuration["database.name"],
    configuration.schema,
    record.database,
    urlInfo.database,
  ), MAX_NAME_LENGTH);
  const catalog = cleanText(firstNonEmptyString(
    configuration.catalog,
    record.catalog,
    urlInfo.catalog,
  ), MAX_NAME_LENGTH);
  const schema = cleanText(firstNonEmptyString(
    configuration.schema,
    configuration.database,
    record.schema,
    urlInfo.schema,
  ), MAX_NAME_LENGTH);
  const redisDbIndex = cleanText(firstNonEmptyString(
    configuration.db,
    configuration.dbIndex,
    configuration.database,
    urlInfo.redisDbIndex,
  ), 16);
  const httpPort = sessionType === "ClickHouse"
    ? String(sanitizePort(parsedPort, 8123))
    : "";
  const ssl = dbeaverSslEnabled(configuration, properties, urlInfo);
  const password = cleanText(firstNonEmptyString(
    configuration.password,
    configuration.userPassword,
    record.password,
    authProperties.password,
    credential?.password,
    credentialSection.password,
    urlInfo.password,
  ), MAX_OPTION_LENGTH);
  const hasExternalPassword = dbeaverTruthy(record["save-password"] ?? record.savePassword ?? configuration["save-password"]);
  if (!password && hasExternalPassword) {
    warnings.push(credentialsLoaded
      ? `DBeaver connection "${label}" has a saved password, but credentials-config.json did not contain a password for this connection.`
      : `DBeaver connection "${label}" has a saved password, but encrypted DBeaver credentials were not imported.`);
  }

  const importedFolder = combineImportFolder("DBeaver", normalizeGroupPath(input.folderPath));
  const optionsJson = JSON.stringify(sanitizeOptions({
    description: "Imported from DBeaver",
    dbDatabase: sessionType === "Redis" ? "" : (sessionType === "Presto" ? schema : database),
    dbCatalog: sessionType === "Presto" ? catalog : "",
    dbSsl: ssl,
    dbTimeout: "15",
    dbHttpPort: httpPort,
    dbChProtocol: sessionType === "ClickHouse" ? "HTTP" : "",
    // jdbc:trino:// (and Trino drivers) need X-Trino-* headers; Presto stays presto.
    dbPrestoDialect:
      sessionType === "Presto"
        ? (isTrinoDriverKey(driverKey) || urlInfo.driverKey?.toLowerCase() === "trino" ? "trino" : "presto")
        : "",
    dbRedisIndex: sessionType === "Redis" ? redisDbIndex || database || "0" : "",
  }));

  const session = importedSession({
    name: label,
    sessionType,
    host,
    port,
    username: optionalCleanText(firstNonEmptyString(
      configuration.user,
      configuration.username,
      configuration["user.name"],
      record.user,
      record.username,
      authProperties.user,
      authProperties.username,
      credential?.user,
      credentialSection.user,
      credentialSection.username,
      urlInfo.username,
    ), MAX_NAME_LENGTH),
    groupPath: combineImportFolder(targetFolder, importedFolder),
    authMethod: "Password",
    options: JSON.parse(optionsJson) as Record<string, unknown>,
    now,
    warnings,
  });
  return session ? { session, password: password || undefined } : null;
}


export function dbeaverSessionType(value: string): string | null {
  const key = value.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(starrocks|starrocksdb|star rocks)\b/.test(key)) return "StarRocks";
  if (/\b(mysql|mariadb|tidb|oceanbase|polardb)\b/.test(key)) return "MySQL";
  if (/\b(panwei|panweidb|open gauss|opengauss)\b/.test(key)) return "PanWeiDB";
  if (/\b(oracle|oracledb|oci|ojdbc)\b/.test(key)) return "Oracle";
  if (/\b(postgresql|postgres|cockroach|yugabyte)\b/.test(key)) return "PostgreSQL";
  if (/\b(sqlserver|sql server|mssql|jtds|azure sql)\b/.test(key)) return "SQLServer";
  if (/\b(clickhouse|click house|chjdbc)\b/.test(key)) return "ClickHouse";
  if (/\b(presto|trino)\b/.test(key)) return "Presto";
  if (/\b(redis|valkey)\b/.test(key)) return "Redis";
  return null;
}


export function parseDbeaverJdbcUrl(rawUrl: string): DbeaverUrlInfo {
  const raw = rawUrl.trim();
  if (!raw) return {};
  let url = raw.replace(/^jdbc:/i, "");
  if (url.toLowerCase().startsWith("jtds:")) {
    url = url.slice(5);
  }
  if (/^oracle:/i.test(url)) {
    return parseOracleJdbcUrl(url);
  }
  if (/^sqlserver:/i.test(url)) {
    return parseSqlServerJdbcUrl(url);
  }

  const driverKey = url.slice(0, Math.max(url.indexOf(":"), 0)) || undefined;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+/, "").split("/").filter(Boolean).map(decodeURIComponent);
    const info: DbeaverUrlInfo = {
      driverKey: driverKey ?? parsed.protocol.replace(/:$/, ""),
      host: parsed.hostname,
      port: parsed.port ? sanitizePort(parsed.port, 0) : undefined,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      ssl: urlSearchSsl(parsed.searchParams),
    };
    const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (protocol === "presto" || protocol === "trino") {
      info.catalog = path[0];
      info.schema = path[1];
    } else if (protocol === "redis" || protocol === "valkey") {
      info.redisDbIndex = path[0];
      info.database = path[0];
    } else {
      info.database = path[0];
    }
    return info;
  } catch {
    return { driverKey };
  }
}


export function parseOracleJdbcUrl(url: string): DbeaverUrlInfo {
  const info: DbeaverUrlInfo = { driverKey: "oracle" };
  const atIndex = url.indexOf("@");
  if (atIndex < 0) return info;
  const connect = url.slice(atIndex + 1).trim();
  if (connect.startsWith("//")) {
    try {
      const parsed = new URL(`oracle:${connect}`);
      const service = parsed.pathname.replace(/^\/+/, "");
      return {
        ...info,
        host: parsed.hostname,
        port: parsed.port ? sanitizePort(parsed.port, DEFAULT_PORTS.Oracle) : undefined,
        database: service ? decodeURIComponent(service) : undefined,
      };
    } catch {
      return info;
    }
  }
  if (connect.startsWith("(")) {
    return { ...info, database: connect };
  }
  const parts = connect.split(":");
  if (parts.length >= 3) {
    return {
      ...info,
      host: parts[0],
      port: sanitizePort(parts[1], DEFAULT_PORTS.Oracle),
      database: parts.slice(2).join(":") || undefined,
    };
  }
  const hostPort = parseHostPort(connect);
  return { ...info, host: hostPort.host, port: hostPort.port };
}


export function parseSqlServerJdbcUrl(url: string): DbeaverUrlInfo {
  const withoutScheme = url.replace(/^sqlserver:/i, "");
  const parts = withoutScheme.split(";").filter(Boolean);
  const authority = (parts.shift() ?? "").replace(/^\/+/, "");
  const props: Record<string, string> = {};
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index > 0) props[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim();
  }
  const slashIndex = authority.indexOf("/");
  const hostText = slashIndex >= 0 ? authority.slice(0, slashIndex) : authority;
  const pathDatabase = slashIndex >= 0 ? authority.slice(slashIndex + 1).split("/").find(Boolean) : undefined;
  const hostPort = parseHostPort(hostText);
  const database = firstNonEmptyString(props.databasename, props.database, pathDatabase ? decodeURIComponent(pathDatabase) : undefined);
  const portNumber = firstNonEmptyString(props.portnumber, props.port);
  return {
    driverKey: "sqlserver",
    host: hostPort.host || firstNonEmptyString(props.servername, props.server, props.host),
    port: hostPort.port ?? (portNumber ? sanitizePort(portNumber, 0) : undefined),
    database,
    username: firstNonEmptyString(props.user, props.username),
    password: firstNonEmptyString(props.password),
    ssl: dbeaverTruthy(props.encrypt) || dbeaverTruthy(props.ssl),
  };
}


export function parseHostPort(value: string): { host?: string; port?: number } {
  const text = value.trim();
  if (!text) return {};
  const ipv6 = /^\[([^\]]+)](?::(\d+))?$/.exec(text);
  if (ipv6) return { host: ipv6[1], port: ipv6[2] ? sanitizePort(ipv6[2], 0) : undefined };
  const index = text.lastIndexOf(":");
  if (index > 0 && /^\d+$/.test(text.slice(index + 1))) {
    return { host: text.slice(0, index), port: sanitizePort(text.slice(index + 1), 0) };
  }
  return { host: text };
}


export function urlSearchSsl(params: URLSearchParams): boolean | undefined {
  for (const key of ["ssl", "useSSL", "encrypt", "SSL"]) {
    const value = params.get(key);
    if (value !== null) return dbeaverTruthy(value);
  }
  const sslMode = params.get("sslmode");
  if (sslMode) return !/^(disable|off|false)$/i.test(sslMode);
  return undefined;
}


export function dbeaverSslEnabled(
  configuration: Record<string, unknown>,
  properties: Record<string, unknown>,
  urlInfo: DbeaverUrlInfo,
): boolean {
  const explicit = firstKnown(
    configuration.ssl,
    configuration.useSSL,
    configuration.encrypt,
    properties.ssl,
    properties.useSSL,
    properties.encrypt,
    urlInfo.ssl,
  );
  if (explicit !== undefined) return dbeaverTruthy(explicit);
  const sslMode = firstNonEmptyString(configuration.sslmode, configuration.sslMode, properties.sslmode, properties.sslMode);
  return Boolean(sslMode && !/^(disable|off|false)$/i.test(sslMode));
}


export function dbeaverTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return /^(true|yes|1|required|verify-ca|verify-full)$/i.test(firstString(value).trim());
}


export function dbeaverFolderLookup(root: Record<string, unknown>): Map<string, string> {
  const folders = isRecord(root.folders) ? root.folders : {};
  const entries = new Map<string, Record<string, unknown>>();
  for (const [id, folder] of Object.entries(folders)) {
    if (isRecord(folder)) entries.set(id, folder);
  }
  const resolved = new Map<string, string>();
  const resolve = (id: string, trail: Set<string> = new Set()): string | null => {
    if (resolved.has(id)) return resolved.get(id) ?? null;
    if (trail.has(id)) return null;
    const folder = entries.get(id);
    if (!folder) return null;
    trail.add(id);
    const explicit = normalizeGroupPath(firstNonEmptyString(folder.path, folder.folderPath));
    if (explicit) {
      resolved.set(id, explicit);
      return explicit;
    }
    const name = cleanText(firstNonEmptyString(folder.name, folder.label, id), MAX_NAME_LENGTH);
    const parentId = cleanText(firstNonEmptyString(folder.parent, folder.parentId), MAX_NAME_LENGTH);
    const parent = parentId ? resolve(parentId, trail) : null;
    const path = normalizeGroupPath(parent && name ? `${parent} / ${name}` : name);
    if (path) resolved.set(id, path);
    return path;
  };
  for (const id of entries.keys()) resolve(id);
  return resolved;
}


export function dbeaverFolderPath(value: unknown, folders: Map<string, string>): string | null {
  const raw = cleanText(firstString(value), MAX_PATH_LENGTH);
  if (!raw) return null;
  return normalizeGroupPath(folders.get(raw) ?? raw);
}


export function looksLikeDbeaverConnection(value: Record<string, unknown>): boolean {
  return Boolean(
    isRecord(value.configuration) ||
      value.url ||
      value.jdbcUrl ||
      value.driver ||
      value.driverId ||
      value.provider ||
      value.host ||
      value.hostname,
  );
}
