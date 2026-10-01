// Shared MFA authenticator types. Mirrors src-tauri/src/mfa/store.rs; every
// timestamp is Unix milliseconds. Stored secrets never reach the renderer.

export type MfaKind = "totp" | "hotp";
export type MfaAlgorithm = "SHA1" | "SHA256" | "SHA512";
export type MfaSortMode = "custom" | "issuer" | "account" | "recent" | "frequent" | "added";

export const MFA_SORT_MODES: MfaSortMode[] = ["custom", "issuer", "account", "recent", "frequent", "added"];
/** Group filter value selecting accounts without a group. */
export const MFA_UNGROUPED = "__ungrouped__";

export interface MfaAccount {
  id: string;
  issuer: string;
  accountName: string;
  group: string;
  note: string;
  kind: MfaKind;
  algorithm: MfaAlgorithm;
  digits: number;
  period: number;
  counter: number;
  pinned: boolean;
  sortOrder: number;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MfaCode {
  id: string;
  code: string;
  nextCode: string | null;
  period: number;
  counter: number;
  validFromMs: number | null;
  validUntilMs: number | null;
}

/** Structured account parsed from a form, otpauth link or QR code. */
export interface MfaAccountInput {
  issuer: string;
  accountName: string;
  /** Base32 secret. */
  secret: string;
  kind: MfaKind;
  algorithm: MfaAlgorithm;
  digits: number;
  period: number;
  counter: number;
  group: string;
  note: string;
}

export interface MfaAccountPatch {
  issuer: string;
  accountName: string;
  group: string;
  note: string;
  pinned: boolean;
}

export interface MfaPrefs {
  sortMode: MfaSortMode;
  groupFilter: string;
}

export interface MfaSnapshot {
  accounts: MfaAccount[];
  prefs: MfaPrefs;
}

export interface MfaInspectItem {
  ok: boolean;
  error: string | null;
  duplicateOf: string | null;
}

export interface MfaAddResult {
  added: MfaAccount[];
  duplicates: number[];
}

/** One decoded luma frame from the desktop clipboard or a screen capture. */
export interface MfaLumaFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export function defaultMfaInput(): MfaAccountInput {
  return {
    issuer: "",
    accountName: "",
    secret: "",
    kind: "totp",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    counter: 0,
    group: "",
    note: "",
  };
}
