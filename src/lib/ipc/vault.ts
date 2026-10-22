import { invoke } from "@tauri-apps/api/core";

// ---------- Vault ----------

export type VaultStateKind = "empty" | "locked" | "unlocked";

export interface VaultStatus {
  state: VaultStateKind;
  entry_count: number;
}

export interface VaultPutResult {
  id: string;
  reference: string;
}

export interface VaultEntrySummary {
  id: string;
  label: string;
  kind: string;
  created_at: number;
  updated_at: number;
}

export const VAULT_REF_PREFIX = "vault:";

export const VAULT_LOCKED_ERROR = "VAULT_LOCKED";

export const VAULT_LOCKED_EVENT = "vault-locked";

export function isVaultReference(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(VAULT_REF_PREFIX);
}

export function isVaultLockedError(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === "string" ? err : (err as Error).message ?? String(err);
  return msg.includes(VAULT_LOCKED_ERROR);
}

/**
 * Run an IPC call and, if it fails with VAULT_LOCKED, emit a global
 * `vault-locked` window event so MainLayout can surface the unlock dialog.
 * The error still propagates so callers can decide whether to retry after
 * the user unlocks (typically via a follow-up await of `whenUnlocked()`).
 */
export async function withVaultLockedNotice<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isVaultLockedError(e)) {
      window.dispatchEvent(new CustomEvent(VAULT_LOCKED_EVENT));
    }
    throw e;
  }
}

export async function vaultStatus(): Promise<VaultStatus> {
  return invoke<VaultStatus>("vault_status");
}

export async function vaultInit(masterPassword: string): Promise<void> {
  return invoke("vault_init", { masterPassword });
}

export async function vaultUnlock(masterPassword: string): Promise<void> {
  return invoke("vault_unlock", { masterPassword });
}

export async function vaultLock(): Promise<void> {
  return invoke("vault_lock");
}

export async function vaultChangeMaster(
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  return invoke("vault_change_master", { oldPassword, newPassword });
}

export async function vaultPut(
  kind: string,
  label: string,
  plaintext: string,
): Promise<VaultPutResult> {
  return invoke<VaultPutResult>("vault_put", { kind, label, plaintext });
}

export async function vaultUpdate(id: string, plaintext: string): Promise<void> {
  return invoke("vault_update", { id, plaintext });
}

export async function vaultDelete(id: string): Promise<void> {
  return invoke("vault_delete", { id });
}

export async function vaultList(): Promise<VaultEntrySummary[]> {
  return invoke<VaultEntrySummary[]>("vault_list");
}
