
/** Automatic reconnect backoff (RealVNC `AutoReconnect`), last step repeats. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000] as const;

export const RECONNECT_STABLE_MS = 30_000;


export function newAttemptId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `vnc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}


export function networkSettingsUsesTunnel(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const settings = JSON.parse(raw) as { proxy_kind?: string; jump_host?: string; jump_session_id?: string; };
    const proxy = settings.proxy_kind && settings.proxy_kind !== "none";
    return Boolean(proxy || settings.jump_host || settings.jump_session_id);
  } catch {
    return false;
  }
}
