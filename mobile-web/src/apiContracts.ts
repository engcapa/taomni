import type {
  BrowserOpenResponse,
  DesktopWindow,
  DesktopWindowsResponse,
  Instance,
  ScreenCapture,
  Session,
  SessionList,
  WindowInputResponse,
} from "./api";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const optBool = (value: unknown) => value === undefined || typeof value === "boolean";

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
      && optBool(value.capabilities.open_sessions)
      && optBool(value.capabilities.screen_capture)
      && optBool(value.capabilities.desktop_control)));
}

export function isScreenCapture(value: unknown): value is ScreenCapture {
  return record(value)
    && nonempty(value.mime)
    && typeof value.width === "number"
    && typeof value.height === "number"
    && typeof value.screen_width === "number"
    && typeof value.screen_height === "number"
    && typeof value.display_id === "string"
    && typeof value.display_name === "string"
    && Array.isArray(value.displays)
    && typeof value.captured_at === "number"
    && nonempty(value.image_b64);
}

export function isDesktopWindows(value: unknown): value is DesktopWindowsResponse {
  const windowItem = (item: unknown): item is DesktopWindow => record(item)
    && nonempty(item.id)
    && typeof item.title === "string"
    && typeof item.app_name === "string"
    && typeof item.pid === "number"
    && typeof item.minimized === "boolean"
    && typeof item.focused === "boolean"
    && typeof item.kind === "string";
  return record(value)
    && Array.isArray(value.windows)
    && value.windows.every(windowItem)
    && typeof value.screen_capture_enabled === "boolean";
}

export function isWindowInputResponse(value: unknown): value is WindowInputResponse {
  return record(value) && value.ok === true && nonempty(value.window_id) && typeof value.title === "string";
}

export function isBrowserOpenResponse(value: unknown): value is BrowserOpenResponse {
  return record(value)
    && value.ok === true
    && nonempty(value.url)
    && nonempty(value.window_id)
    && typeof value.title === "string"
    && typeof value.screen_capture_enabled === "boolean";
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
