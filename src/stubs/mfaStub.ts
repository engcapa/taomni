// Browser-preview model of src-tauri/src/mfa (mfa.db + vault data key).
// Persists to localStorage, generates codes with WebCrypto and mirrors the
// backend's validation, duplicate detection and VAULT_LOCKED behaviour. It
// proves renderer orchestration only; Rust tests and native QA cover the real
// store. Desktop-only image sources report MFA_DESKTOP_ONLY.

import { decodeBase32, MIN_SECRET_BYTES, normalizeBase32 } from "../lib/mfa/base32";
import { buildOtpauthUri } from "../lib/mfa/otpauth";
import {
  MFA_SORT_MODES,
  type MfaAccount,
  type MfaAccountInput,
  type MfaAccountPatch,
  type MfaAlgorithm,
  type MfaCode,
  type MfaInspectItem,
  type MfaPrefs,
} from "../lib/mfa/types";

export const MFA_STUB_STORAGE_KEY = "taomni.stub.mfa.v1";

interface StubAccount extends MfaAccount {
  secret: string;
  fingerprint: string;
}

interface StubState {
  accounts: StubAccount[];
  prefs: MfaPrefs;
}

const HASHES: Record<MfaAlgorithm, string> = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

function load(): StubState {
  try {
    const parsed = JSON.parse(localStorage.getItem(MFA_STUB_STORAGE_KEY) ?? "null");
    if (parsed && Array.isArray(parsed.accounts)) return parsed as StubState;
  } catch {
    // Corrupt preview state falls back to an empty store.
  }
  return { accounts: [], prefs: { sortMode: "custom", groupFilter: "" } };
}

function save(state: StubState): void {
  localStorage.setItem(MFA_STUB_STORAGE_KEY, JSON.stringify(state));
}

function publicAccount(account: StubAccount): MfaAccount {
  const copy: Partial<StubAccount> = { ...account };
  delete copy.secret;
  delete copy.fingerprint;
  return copy as MfaAccount;
}

export async function stubHotp(secret: Uint8Array, counter: number, digits: number, algorithm: MfaAlgorithm): Promise<string> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(secret), { name: "HMAC", hash: HASHES[algorithm] }, false, ["sign"]);
  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

function invalid(field: string, detail: string): Error {
  return new Error(`MFA_INVALID_INPUT: ${field}: ${detail}`);
}

function clean(value: string | undefined, field: string, max: number): string {
  const trimmed = (value ?? "").trim();
  if ([...trimmed].length > max) throw invalid(field, `longer than ${max} characters`);
  return trimmed;
}

interface ValidStubInput extends MfaAccountInput {
  fingerprint: string;
}

function validate(input: MfaAccountInput): ValidStubInput {
  const issuer = clean(input.issuer, "issuer", 128);
  const accountName = clean(input.accountName, "accountName", 256);
  if (!issuer && !accountName) throw invalid("issuer", "an issuer or account name is required");
  const kind = String(input.kind ?? "totp").trim().toLowerCase();
  if (kind !== "totp" && kind !== "hotp") throw invalid("kind", "must be totp or hotp");
  const algorithm = String(input.algorithm ?? "SHA1").trim().toUpperCase().replace(/-/g, "") as MfaAlgorithm;
  if (!(algorithm in HASHES)) throw invalid("algorithm", "must be SHA1, SHA256 or SHA512");
  const digits = Number(input.digits ?? 6);
  if (![6, 7, 8].includes(digits)) throw invalid("digits", "must be 6, 7 or 8");
  const period = kind === "totp" ? Number(input.period ?? 30) : 30;
  if (kind === "totp" && !(period >= 15 && period <= 300)) throw invalid("period", "must be between 15 and 300 seconds");
  let bytes: Uint8Array;
  try {
    bytes = decodeBase32(input.secret ?? "");
  } catch (err) {
    throw invalid("secret", err instanceof Error ? err.message : String(err));
  }
  if (bytes.length === 0) throw invalid("secret", "is required");
  if (bytes.length < MIN_SECRET_BYTES) throw invalid("secret", "is too short (at least 16 Base32 characters)");
  const secret = normalizeBase32(input.secret);
  return {
    issuer,
    accountName,
    secret,
    kind,
    algorithm,
    digits,
    period,
    counter: kind === "hotp" ? Math.max(0, Math.floor(Number(input.counter ?? 0))) : 0,
    group: clean(input.group, "group", 64),
    note: clean(input.note, "note", 1024),
    fingerprint: `${kind}|${algorithm}|${digits}|${period}|${[...bytes].join(",")}`,
  };
}
async function codeFor(account: StubAccount, nowMs: number): Promise<MfaCode> {
  const secret = decodeBase32(account.secret);
  if (account.kind === "hotp") {
    return {
      id: account.id,
      code: await stubHotp(secret, account.counter, account.digits, account.algorithm),
      nextCode: null,
      period: account.period,
      counter: account.counter,
      validFromMs: null,
      validUntilMs: null,
    };
  }
  const periodMs = account.period * 1000;
  const step = Math.floor(nowMs / periodMs);
  return {
    id: account.id,
    code: await stubHotp(secret, step, account.digits, account.algorithm),
    nextCode: await stubHotp(secret, step + 1, account.digits, account.algorithm),
    period: account.period,
    counter: step,
    validFromMs: step * periodMs,
    validUntilMs: (step + 1) * periodMs,
  };
}

function requireAccount(state: StubState, id: unknown): StubAccount {
  const account = state.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error("MFA_NOT_FOUND");
  return account;
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `stub-mfa-${Date.now()}-${idCounter}`;
}

/**
 * Dispatch one `mfa_*` command. `vaultUnlocked` mirrors the stub vault;
 * `masterPassword` is its password, checked by `mfa_export_uri` like the
 * backend's `verify_master_password` (no password set = nothing to check).
 */
export async function stubMfaInvoke(
  cmd: string,
  args: Record<string, unknown> | undefined,
  vaultUnlocked: boolean,
  masterPassword?: string,
): Promise<unknown> {
  if (cmd === "mfa_read_clipboard_image" || cmd === "mfa_capture_screens") {
    throw new Error("MFA_DESKTOP_ONLY");
  }
  if (!vaultUnlocked) throw new Error("VAULT_LOCKED");
  const state = load();
  const now = Date.now();
  switch (cmd) {
    case "mfa_list":
      return { accounts: [...state.accounts].sort((a, b) => a.sortOrder - b.sortOrder).map(publicAccount), prefs: state.prefs };
    case "mfa_codes": {
      const ids = args?.ids as string[] | null | undefined;
      const wanted = state.accounts.filter((account) => !ids || ids.includes(account.id));
      return Promise.all(wanted.map((account) => codeFor(account, now)));
    }
    case "mfa_inspect":
      return ((args?.inputs as MfaAccountInput[]) ?? []).map((input): MfaInspectItem => {
        try {
          const valid = validate(input);
          const duplicate = state.accounts.find((account) => account.fingerprint === valid.fingerprint);
          return { ok: true, error: null, duplicateOf: duplicate?.id ?? null };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err), duplicateOf: null };
        }
      });
    case "mfa_add": {
      const valid = ((args?.inputs as MfaAccountInput[]) ?? []).map(validate);
      const added: MfaAccount[] = [];
      const duplicates: number[] = [];
      const next = [...state.accounts];
      valid.forEach((input, index) => {
        if (next.some((account) => account.fingerprint === input.fingerprint)) {
          if (!args?.skipDuplicates) throw invalid("secret", "account already exists");
          duplicates.push(index);
          return;
        }
        const account: StubAccount = {
          ...input,
          id: newId(),
          pinned: false,
          sortOrder: next.reduce((max, entry) => Math.max(max, entry.sortOrder), -1) + 1,
          useCount: 0,
          lastUsedAt: null,
          createdAt: now + index,
          updatedAt: now + index,
        };
        next.push(account);
        added.push(publicAccount(account));
      });
      save({ ...state, accounts: next });
      return { added, duplicates };
    }
    case "mfa_update": {
      const account = requireAccount(state, args?.id);
      const patch = args?.patch as MfaAccountPatch;
      const issuer = clean(patch.issuer, "issuer", 128);
      const accountName = clean(patch.accountName, "accountName", 256);
      if (!issuer && !accountName) throw invalid("issuer", "an issuer or account name is required");
      Object.assign(account, {
        issuer,
        accountName,
        group: clean(patch.group, "group", 64),
        note: clean(patch.note, "note", 1024),
        pinned: Boolean(patch.pinned),
        updatedAt: now,
      });
      save(state);
      return publicAccount(account);
    }
    case "mfa_delete": {
      requireAccount(state, args?.id);
      save({ ...state, accounts: state.accounts.filter((account) => account.id !== args?.id) });
      return undefined;
    }
    case "mfa_reorder": {
      const ids = ((args?.ids as string[]) ?? []).filter((id, index, all) => all.indexOf(id) === index);
      const ordered = [...state.accounts].sort((a, b) => a.sortOrder - b.sortOrder);
      const rank = (account: StubAccount) => {
        const index = ids.indexOf(account.id);
        return index >= 0 ? index : ids.length + ordered.indexOf(account);
      };
      ordered.sort((a, b) => rank(a) - rank(b)).forEach((account, index) => {
        account.sortOrder = index;
      });
      save({ ...state, accounts: ordered });
      return undefined;
    }
    case "mfa_hotp_next": {
      const account = requireAccount(state, args?.id);
      if (account.kind !== "hotp") throw new Error("MFA_NOT_FOUND");
      account.counter += 1;
      account.updatedAt = now;
      save(state);
      return codeFor(account, now);
    }
    case "mfa_mark_used": {
      const account = requireAccount(state, args?.id);
      account.useCount += 1;
      account.lastUsedAt = now;
      save(state);
      return publicAccount(account);
    }
    case "mfa_set_prefs": {
      const prefs = args?.prefs as MfaPrefs;
      if (!MFA_SORT_MODES.includes(prefs.sortMode)) throw invalid("sortMode", "unknown sort mode");
      save({ ...state, prefs: { sortMode: prefs.sortMode, groupFilter: clean(prefs.groupFilter, "groupFilter", 64) } });
      return undefined;
    }
    case "mfa_reset_store":
      save({ ...state, accounts: [] });
      return undefined;
    case "mfa_export_uri": {
      if (masterPassword) {
        const given = String(args?.masterPassword ?? "").trim();
        if (!given) throw new Error("VAULT_PASSWORD_REQUIRED");
        if (given !== masterPassword.trim()) throw new Error("VAULT_BAD_PASSWORD");
      }
      return buildOtpauthUri(requireAccount(state, args?.id));
    }
    default:
      throw new Error(`unknown MFA command ${cmd}`);
  }
}
