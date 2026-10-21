import type { AuthMethod } from "../ipc";
import { type SessionImportOptions, type SessionImportResult, MAX_HOST_LENGTH, MAX_NAME_LENGTH, MAX_PATH_LENGTH } from "./model";
import { assertImportSize, resolveNow, parseIniSections, cleanText, firstNonEmptyString, getIni, protocolToSessionType, folderFromSourcePath, nameFromSourcePath, optionalCleanText, importedSession, combineImportFolder, finalizeImportResult, privateKeyAuth, toUint8Array } from "./shared";
import { MAX_IMPORT_ARCHIVE_BYTES, readZipTextEntries, decodeImportedText } from "./archive";


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
export function xshellAuthMethod(
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
export function xshellKeyPath(keyName: string): string {
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


export function isZipArchive(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}
