// Parse text decoded from a QR code or pasted by the user into structured MFA
// inputs. Supports otpauth://totp|hotp links (Key URI Format) and Google
// Authenticator otpauth-migration exports. The backend re-validates every
// field (src-tauri/src/mfa/store.rs validate_input).

import { normalizeBase32 } from "./base32";
import { decodeMigrationData, migrationEntryToInput } from "./migration";
import { defaultMfaInput, type MfaAccountInput, type MfaAlgorithm } from "./types";

export type MfaImportErrorReason = "not-otp" | "invalid";

export class MfaImportError extends Error {
  readonly reason: MfaImportErrorReason;

  constructor(reason: MfaImportErrorReason, message: string) {
    super(message);
    this.name = "MfaImportError";
    this.reason = reason;
  }
}

/** One importable account, or the reason a migration entry is unusable. */
export interface MfaParsedItem {
  input: MfaAccountInput | null;
  error: string | null;
  /** Display label even when the entry cannot be imported. */
  label: string;
}

const OTPAUTH = /^otpauth:\/\/([^/?#]*)\/([^?#]*)(?:\?([^#]*))?/i;
const MIGRATION = /^otpauth-migration:\/\/[^?#]*\?([^#]*)/i;
const ALGORITHMS: MfaAlgorithm[] = ["SHA1", "SHA256", "SHA512"];

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function integerParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new MfaImportError("invalid", `"${name}" must be a number`);
  return Number.parseInt(raw.trim(), 10);
}

export function isOtpauthLink(text: string): boolean {
  const trimmed = text.trim();
  return OTPAUTH.test(trimmed) || MIGRATION.test(trimmed);
}

export function accountLabel(input: Pick<MfaAccountInput, "issuer" | "accountName">): string {
  if (input.issuer && input.accountName) return `${input.issuer} · ${input.accountName}`;
  return input.issuer || input.accountName || "?";
}

/** encodeURIComponent plus `!'()*`, matching the backend's RFC 3986 encoding. */
function uriComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `otpauth://` link in the same form as src-tauri/src/mfa/otp.rs
 * `otpauth_uri` (the browser stub's export). Label `issuer:account`, issuer
 * repeated as a parameter, HOTP with the current counter, TOTP with its period.
 */
export function buildOtpauthUri(
  account: Pick<MfaAccountInput, "kind" | "issuer" | "accountName" | "secret" | "algorithm" | "digits" | "period" | "counter">,
): string {
  const label = account.issuer
    ? `${uriComponent(account.issuer)}:${uriComponent(account.accountName)}`
    : uriComponent(account.accountName);
  let uri = `otpauth://${account.kind}/${label}?secret=${normalizeBase32(account.secret)}`;
  if (account.issuer) uri += `&issuer=${uriComponent(account.issuer)}`;
  uri += `&algorithm=${account.algorithm}&digits=${account.digits}`;
  uri += account.kind === "totp" ? `&period=${account.period}` : `&counter=${account.counter}`;
  return uri;
}

export function parseOtpauthUri(text: string): MfaAccountInput {
  const match = OTPAUTH.exec(text.trim());
  if (!match) throw new MfaImportError("not-otp", "not an otpauth:// link");
  const type = match[1].toLowerCase();
  if (type !== "totp" && type !== "hotp") {
    throw new MfaImportError("invalid", `unsupported OTP type "${match[1]}"`);
  }
  const params = new URLSearchParams(match[3] ?? "");
  const secret = (params.get("secret") ?? "").trim();
  if (!secret) throw new MfaImportError("invalid", "the link has no secret");

  let issuer = (params.get("issuer") ?? "").trim();
  let accountName = safeDecode(match[2]).trim();
  const colon = accountName.indexOf(":");
  if (colon >= 0) {
    const prefix = accountName.slice(0, colon).trim();
    accountName = accountName.slice(colon + 1).trim();
    if (!issuer) issuer = prefix;
  }
  const algorithm = (params.get("algorithm") ?? "SHA1").trim().toUpperCase().replace(/-/g, "");
  if (!ALGORITHMS.includes(algorithm as MfaAlgorithm)) {
    throw new MfaImportError("invalid", `unsupported algorithm "${algorithm}"`);
  }
  return {
    ...defaultMfaInput(),
    issuer,
    accountName,
    secret,
    kind: type,
    algorithm: algorithm as MfaAlgorithm,
    digits: integerParam(params, "digits", 6),
    period: type === "totp" ? integerParam(params, "period", 30) : 30,
    counter: type === "hotp" ? integerParam(params, "counter", 0) : 0,
  };
}

/** Parse any supported QR/clipboard text into importable items. */
export function parseImportText(text: string): MfaParsedItem[] {
  const trimmed = text.trim();
  const migration = MIGRATION.exec(trimmed);
  if (migration) {
    const data = new URLSearchParams(migration[1]).get("data");
    if (!data) throw new MfaImportError("invalid", "the migration link has no data");
    let entries: ReturnType<typeof decodeMigrationData>;
    try {
      entries = decodeMigrationData(data);
    } catch (err) {
      throw new MfaImportError("invalid", `unreadable migration data (${err instanceof Error ? err.message : String(err)})`);
    }
    if (entries.length === 0) throw new MfaImportError("invalid", "the migration link contains no accounts");
    return entries.map((entry) => {
      const { input, error } = migrationEntryToInput(entry);
      return { input, error, label: accountLabel(input ?? { issuer: entry.issuer, accountName: entry.name }) };
    });
  }
  const input = parseOtpauthUri(trimmed);
  return [{ input, error: null, label: accountLabel(input) }];
}

/** Like {@link parseImportText} but over several decoded QR strings. */
export function parseImportTexts(texts: string[]): { items: MfaParsedItem[]; rejected: string[] } {
  const items: MfaParsedItem[] = [];
  const rejected: string[] = [];
  for (const text of texts) {
    try {
      items.push(...parseImportText(text));
    } catch (err) {
      if (err instanceof MfaImportError && err.reason === "invalid") throw err;
      rejected.push(text);
    }
  }
  return { items, rejected };
}
