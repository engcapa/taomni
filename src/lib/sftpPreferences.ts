/**
 * Global SFTP UI preferences (localStorage-backed).
 *
 * Currently covers local-pane double-click behavior for dual-pane SFTP
 * (dedicated SFTP sessions + sidebar SFTP pane). Default keeps the historical
 * "open with system default app" behavior.
 */

export type SftpLocalDoubleClickAction = "open" | "upload";

export interface SftpPreferences {
  /** Double-click a local file: open in OS, or upload to the remote pane. */
  localDoubleClickAction: SftpLocalDoubleClickAction;
}

export const DEFAULT_SFTP_PREFERENCES: SftpPreferences = {
  localDoubleClickAction: "open",
};

export const SFTP_PREFERENCES_STORAGE_KEY = "taomni.sftpPreferences.v1";
export const SFTP_PREFERENCES_EVENT = "taomni:sftp-preferences-changed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSftpPreferences(input: unknown): SftpPreferences {
  const source = isRecord(input) ? input : {};
  const action = source.localDoubleClickAction;
  return {
    localDoubleClickAction:
      action === "open" || action === "upload"
        ? action
        : DEFAULT_SFTP_PREFERENCES.localDoubleClickAction,
  };
}

export function loadSftpPreferences(): SftpPreferences {
  if (typeof window === "undefined") return DEFAULT_SFTP_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(SFTP_PREFERENCES_STORAGE_KEY);
    return normalizeSftpPreferences(raw ? JSON.parse(raw) : undefined);
  } catch {
    return DEFAULT_SFTP_PREFERENCES;
  }
}

export function saveSftpPreferences(preferences: SftpPreferences): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeSftpPreferences(preferences);
  try {
    window.localStorage.setItem(
      SFTP_PREFERENCES_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // localStorage unavailable
  }
  try {
    window.dispatchEvent(
      new CustomEvent(SFTP_PREFERENCES_EVENT, { detail: normalized }),
    );
  } catch {
    // CustomEvent unavailable
  }
}

export function subscribeSftpPreferences(
  listener: (preferences: SftpPreferences) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => {
    listener(
      normalizeSftpPreferences(
        (event as CustomEvent<SftpPreferences>).detail,
      ),
    );
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== SFTP_PREFERENCES_STORAGE_KEY) return;
    listener(loadSftpPreferences());
  };
  window.addEventListener(SFTP_PREFERENCES_EVENT, onCustom as EventListener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SFTP_PREFERENCES_EVENT, onCustom as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}
