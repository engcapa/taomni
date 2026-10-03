import { invoke } from "@tauri-apps/api/core";
import { parseLumaFrames } from "./frames";
import type {
  MfaAccount,
  MfaAccountInput,
  MfaAccountPatch,
  MfaAddResult,
  MfaCode,
  MfaInspectItem,
  MfaLumaFrame,
  MfaPrefs,
  MfaSnapshot,
} from "./types";

export const mfaList = () => invoke<MfaSnapshot>("mfa_list");

export const mfaCodes = (ids?: string[]) => invoke<MfaCode[]>("mfa_codes", { ids: ids ?? null });

export const mfaInspect = (inputs: MfaAccountInput[]) =>
  invoke<MfaInspectItem[]>("mfa_inspect", { inputs });

export const mfaAdd = (inputs: MfaAccountInput[], skipDuplicates: boolean) =>
  invoke<MfaAddResult>("mfa_add", { inputs, skipDuplicates });

export const mfaUpdate = (id: string, patch: MfaAccountPatch) =>
  invoke<MfaAccount>("mfa_update", { id, patch });

export const mfaDelete = (id: string) => invoke<void>("mfa_delete", { id });

export const mfaReorder = (ids: string[]) => invoke<void>("mfa_reorder", { ids });

export const mfaHotpNext = (id: string) => invoke<MfaCode>("mfa_hotp_next", { id });

export const mfaMarkUsed = (id: string) => invoke<MfaAccount>("mfa_mark_used", { id });

export const mfaSetPrefs = (prefs: MfaPrefs) => invoke<void>("mfa_set_prefs", { prefs });

export const mfaResetStore = () => invoke<void>("mfa_reset_store");

/**
 * `otpauth://` link of one account for its QR code. The only call that returns
 * a stored secret, so the backend re-checks the master password
 * (VAULT_BAD_PASSWORD / VAULT_PASSWORD_REQUIRED).
 */
export const mfaExportUri = (id: string, masterPassword: string) =>
  invoke<string>("mfa_export_uri", { id, masterPassword });

/** Desktop clipboard image as luma frames (throws MFA_CLIPBOARD_NO_IMAGE). */
export async function mfaReadClipboardImage(): Promise<MfaLumaFrame[]> {
  return parseLumaFrames(await invoke<ArrayBuffer>("mfa_read_clipboard_image"));
}

/** Hide the window, capture every display and return luma frames. */
export async function mfaCaptureScreens(): Promise<MfaLumaFrame[]> {
  return parseLumaFrames(await invoke<ArrayBuffer>("mfa_capture_screens"));
}
