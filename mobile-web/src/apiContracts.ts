import type { Instance, Session, SessionList } from "./api";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function isPairingResponse(value: unknown): value is { device_id: string; token: string } {
  return record(value) && nonempty(value.device_id) && nonempty(value.token);
}

export function isSessionList(value: unknown): value is SessionList {
  const session = (item: unknown): item is Session => record(item)
    && nonempty(item.id) && (item.kind === "terminal" || item.kind === "agent")
    && typeof item.title === "string" && typeof item.status === "string" && typeof item.summary === "string";
  return record(value) && Array.isArray(value.sessions) && value.sessions.every(session)
    && Array.isArray(value.saved_sessions) && value.saved_sessions.every(item => record(item)
      && nonempty(item.id) && typeof item.name === "string" && typeof item.session_type === "string"
      && (item.group_path === null || typeof item.group_path === "string"))
    && (value.capabilities === undefined || (record(value.capabilities)
      && (value.capabilities.open_sessions === undefined || typeof value.capabilities.open_sessions === "boolean")));
}

export function isStoredInstance(value: unknown): value is Instance {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.endpoint) || !nonempty(value.label)
      || !nonempty(value.token) || !nonempty(value.deviceId)) return false;
  try {
    const url = new URL(value.endpoint);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && ["", "/"].includes(url.pathname);
  } catch { return false; }
}
