/** Split a code into two readable halves: 755224 → "755 224", 1234567 → "123 4567". */
export function formatCode(code: string): string {
  if (code.length < 6) return code;
  const half = Math.floor(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

/** Split Base32 secret into 4-character chunks for readable display: JBSWY3DPEHPK3PXP → "JBSW Y3DP EHPK 3PXP". */
export function formatSecretKey(secret: string): string {
  const clean = secret.replace(/\s+/g, "").toUpperCase();
  if (!clean) return "";
  return clean.match(/.{1,4}/g)?.join(" ") ?? clean;
}

/** Whole seconds left in a TOTP window (never below zero). */
export function remainingSeconds(validUntilMs: number | null, nowMs: number, validFromMs: number | null = null): number {
  if (validUntilMs === null) return 0;
  // A refreshed code can arrive before the UI clock ticks past its boundary.
  const effectiveNow = Math.max(nowMs, validFromMs ?? nowMs);
  return Math.max(0, Math.ceil((validUntilMs - effectiveNow) / 1000));
}

/** Known backend error codes; anything else is shown verbatim. */
export type MfaErrorCode =
  | "VAULT_LOCKED"
  | "MFA_KEY_MISSING"
  | "MFA_KEY_MISMATCH"
  | "MFA_INVALID_INPUT"
  | "MFA_NOT_FOUND"
  | "MFA_CLIPBOARD_NO_IMAGE"
  | "MFA_SCREEN_PERMISSION"
  | "MFA_NO_DISPLAY"
  | "MFA_CAPTURE_FAILED"
  | "MFA_DESKTOP_ONLY";

const CODES: MfaErrorCode[] = [
  "VAULT_LOCKED",
  "MFA_KEY_MISSING",
  "MFA_KEY_MISMATCH",
  "MFA_INVALID_INPUT",
  "MFA_NOT_FOUND",
  "MFA_CLIPBOARD_NO_IMAGE",
  "MFA_SCREEN_PERMISSION",
  "MFA_NO_DISPLAY",
  "MFA_CAPTURE_FAILED",
  "MFA_DESKTOP_ONLY",
];

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

export function mfaErrorCode(err: unknown): MfaErrorCode | null {
  const text = errorText(err);
  return CODES.find((code) => text.startsWith(code)) ?? null;
}

/** `MFA_INVALID_INPUT: <field>: <detail>` → `{ field, detail }`. */
export function invalidInputField(err: unknown): { field: string; detail: string } | null {
  const match = /^MFA_INVALID_INPUT: ([A-Za-z]+): (.*)$/s.exec(errorText(err));
  return match ? { field: match[1], detail: match[2] } : null;
}
