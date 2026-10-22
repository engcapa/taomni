import { invoke } from "@tauri-apps/api/core";

// --- Third-party importer secret recovery ---

export interface KeychainQuery {
  service: string;
  account: string;
}

export interface KeychainHit {
  service: string;
  account: string;
  found: boolean;
  value?: string;
  error?: string;
}

export async function keychainLookupBatch(
  entries: KeychainQuery[],
): Promise<KeychainHit[]> {
  return invoke<KeychainHit[]>("keychain_lookup_batch", { entries });
}

export type TabbySecret =
  | { kind: "password"; host: string; port?: number; user?: string; value: string }
  | { kind: "key-passphrase"; id: string; value: string };

export interface TabbyDecryptVaultResponse {
  secrets: TabbySecret[];
}

export const TABBY_VAULT_BAD_PASSWORD = "tabby_vault_bad_password";

export const TABBY_VAULT_MISSING = "tabby_vault_missing";

export function isTabbyBadPasswordError(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === "string" ? err : (err as Error).message ?? String(err);
  return msg.includes(TABBY_VAULT_BAD_PASSWORD);
}

export async function tabbyDecryptVault(
  yamlText: string,
  masterPassword: string,
): Promise<TabbyDecryptVaultResponse> {
  return invoke<TabbyDecryptVaultResponse>("tabby_decrypt_vault", {
    args: { yamlText, masterPassword },
  });
}

export interface SecureCrtPasswordRequest {
  sessionId: string;
  encrypted: string;
}

export interface SecureCrtPasswordHit {
  sessionId: string;
  value: string;
}

export interface SecureCrtPasswordFailure {
  sessionId: string;
  error: string;
  needsPassphrase: boolean;
}

export interface SecureCrtDecryptResponse {
  secrets: SecureCrtPasswordHit[];
  failures: SecureCrtPasswordFailure[];
}

export const SECURECRT_PASSWORD_BAD_PASSPHRASE = "securecrt_password_bad_passphrase";

export async function secureCrtDecryptPasswords(
  passwords: SecureCrtPasswordRequest[],
  passphrase: string,
): Promise<SecureCrtDecryptResponse> {
  return invoke<SecureCrtDecryptResponse>("securecrt_decrypt_passwords", {
    args: { passwords, passphrase },
  });
}
