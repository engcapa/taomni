import type { SessionConfig } from "../ipc";
import { type SessionImportOptions, type SessionImportResult, MAX_ZEROOMEGA_IMPORT_CHARS, MAX_SESSIONS, MAX_NAME_LENGTH, MAX_HOST_LENGTH } from "./model";
import { assertImportSize, isRecord, resolveNow, cleanText, optionalCleanText, firstString, importedSession, combineImportFolder, finalizeImportResult } from "./shared";


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
export function pickZeroOmegaProxy(profile: Record<string, unknown>): unknown {
  return (
    profile.fallbackProxy ??
    profile.proxyForHttps ??
    profile.proxyForHttp ??
    profile.proxyForFtp ??
    null
  );
}
