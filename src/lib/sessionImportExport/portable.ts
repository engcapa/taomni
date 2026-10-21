import type { SessionConfig } from "../ipc";
import { normalizeGroupPath } from "../sessionPaths";
import { type SessionImportOptions, type SessionImportResult, type SessionExportResult, TAOMNI_FORMAT, SCHEMA_VERSION, LEGACY_FORMAT, type PortableSession, MAX_NAME_LENGTH, MAX_HOST_LENGTH, DEFAULT_PORTS } from "./model";
import { assertImportSize, resolveNow, rowToSession, finalizeImportResult, slugify, limitRows, isRecord, firstString, cleanText, sanitizeSessionType, relativeFolderPath, sanitizePort, optionalCleanText, authMethodToPortable, sanitizeOptions, sanitizeInteger } from "./shared";


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


export function extractTaomniRows(
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


export function toPortableSession(session: SessionConfig, scopeFolder: string | null): PortableSession {
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
