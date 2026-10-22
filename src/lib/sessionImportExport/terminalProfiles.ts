import type { SessionConfig } from "../ipc";
import { normalizeGroupPath } from "../sessionPaths";
import { parseSshConnectionCommand } from "../quickConnect";
import { type SessionImportOptions, type SessionImportResult, MAX_HOST_LENGTH, MAX_NAME_LENGTH, MAX_PATH_LENGTH, MAX_OPTION_LENGTH, type SecureCrtEncryptedPassword } from "./model";
import { assertImportSize, parsePlistDicts, resolveNow, parseXmlElementAttributes, parseXmlChildElementRecords, cleanText, firstXmlAttr, protocolToSessionType, importedSession, optionalCleanText, combineImportFolder, privateKeyAuth, finalizeImportResult, parseIniSections, firstNonEmptyString, getIni, folderFromSourcePath, nameFromSourcePath, firstKnown, isRecord, firstString } from "./shared";


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
    const sshTarget = parseSshConnectionCommand(command);
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
  const keyPath = cleanText(firstNonEmptyString(values["identity filename v2"], values["identity filename"], values.identityfile), MAX_PATH_LENGTH);
  const encryptedPassword = cleanText(firstNonEmptyString(values["password v2"], values.password), MAX_OPTION_LENGTH);
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
  const secureCrtPasswords: SecureCrtEncryptedPassword[] = [];
  if (session && encryptedPassword) {
    secureCrtPasswords.push({
      sessionId: session.id,
      label: `${session.username ?? "user"}@${session.host}:${session.port}`,
      encrypted: encryptedPassword,
    });
    warnings.push(
      "SecureCRT saved password detected. Taomni will try the default empty SecureCRT passphrase first and prompt for the SecureCRT configuration passphrase if needed.",
    );
  }

  return finalizeImportResult(
    session ? [session] : [],
    session ? 0 : 1,
    session ? warnings : [...warnings, "Skipped a SecureCRT session because host is empty."],
    options.existingSessions,
    [],
    secureCrtPasswords,
    undefined,
    secureCrtPasswords.length > 0 ? "securecrt" : undefined,
  );
}


export function parseJsonOrPlistProfiles(
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


export function sshCommandProfilesToImportResult(
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
    const parsed = parseSshConnectionCommand(command);
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


export function parseSecureCrtIni(text: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^([A-Z]):"([^"]+)"=(.*)$/i.exec(rawLine.trim());
    if (!match) continue;
    const valueType = match[1].toUpperCase();
    const key = match[2].trim().toLowerCase();
    const value = match[3].trim();
    values[key] = valueType === "D" && /^[0-9a-f]{8}$/i.test(value)
      ? Number.parseInt(value, 16)
      : value;
  }
  return values;
}
