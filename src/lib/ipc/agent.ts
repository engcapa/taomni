import { invoke } from "@tauri-apps/api/core";
import { withVaultLockedNotice } from "./vault";

/**
 * Return the raw user-supplied Claude Code settings.json (decrypted from the
 * vault) for the Settings editor, or null when none is configured. Wrapped in
 * `withVaultLockedNotice` so a locked vault prompts the unlock dialog.
 */
export async function ccGetCustomSettings(): Promise<string | null> {
  return withVaultLockedNotice(() =>
    invoke<string | null>("cc_get_custom_settings"),
  );
}

export async function ccGetProfileSettings(vaultRef: string): Promise<string | null> {
  return withVaultLockedNotice(() =>
    invoke<string | null>("cc_get_profile_settings", { vaultRef }),
  );
}

export async function codexGetCustomConfig(): Promise<string | null> {
  return withVaultLockedNotice(() =>
    invoke<string | null>("codex_get_custom_config"),
  );
}

export async function codexGetProfileConfig(vaultRef: string): Promise<string | null> {
  return withVaultLockedNotice(() =>
    invoke<string | null>("codex_get_profile_config", { vaultRef }),
  );
}
