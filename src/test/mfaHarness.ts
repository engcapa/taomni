import type { MfaAccount, MfaCode } from "../lib/mfa/types";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function mfaAccount(id = "account"): MfaAccount {
  return {
    id, issuer: "QA Bank", accountName: "qa", group: "", note: "", kind: "hotp",
    algorithm: "SHA1", digits: 6, period: 30, counter: 0, pinned: false,
    sortOrder: 0, useCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0,
  };
}

export function mfaCode(code = "755224"): MfaCode {
  return { id: "account", code, nextCode: null, counter: 0, period: 30, validFromMs: null, validUntilMs: null };
}
