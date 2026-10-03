import { normalizeVncScaling, type VncScaling } from "./vnc";

/**
 * Per-session VNC viewer options (VNC-CONN-001), modelled on RealVNC Viewer's
 * Properties > Options and the Expert parameters that matter for third-party
 * servers. Stored as flat `vnc*` keys in the session's `options_json`; a key
 * that is missing (sessions saved by older builds) reads as the RealVNC
 * default, so existing sessions behave exactly as before.
 */
export type VncPictureQuality = "automatic" | "high" | "medium" | "low";
export type VncMenuKey = "F8" | "F9" | "F10" | "F11" | "F12" | "none";

export interface VncViewerOptions {
  /** RealVNC `Quality` (Automatic by default). */
  pictureQuality: VncPictureQuality;
  /** RealVNC `Scaling` (Automatic by default). */
  scaling: VncScaling;
  preserveAspect: boolean;
  /** ClientInit shared flag (RealVNC `Shared=True`). */
  shared: boolean;
  /** RealVNC `SendSpecialKeys`: Win, Alt+Tab, Alt+Esc, Ctrl+Esc, PrtScn (Windows). */
  passSpecialKeys: boolean;
  /** RealVNC `AcceptBell`. */
  acceptBell: boolean;
  /** RealVNC `MenuKey` (F8 by default; "none" disables the shortcut). */
  menuKey: VncMenuKey;
  /** RealVNC `SendInitialClipboard=False`. */
  sendInitialClipboard: boolean;
  /** RealVNC `WarnUnencrypted=True`. */
  warnUnencrypted: boolean;
  /** RealVNC `AutoReconnect=True`. */
  autoReconnect: boolean;
}

export const DEFAULT_VNC_VIEWER_OPTIONS: VncViewerOptions = {
  pictureQuality: "automatic",
  scaling: "auto",
  preserveAspect: true,
  shared: true,
  passSpecialKeys: true,
  acceptBell: true,
  menuKey: "F8",
  sendInitialClipboard: false,
  warnUnencrypted: true,
  autoReconnect: true,
};

const QUALITIES: readonly VncPictureQuality[] = ["automatic", "high", "medium", "low"];
const MENU_KEYS: readonly VncMenuKey[] = ["F8", "F9", "F10", "F11", "F12", "none"];

/** Session `options_json` keys, one per viewer option. */
export const VNC_OPTION_KEYS: Record<keyof VncViewerOptions, string> = {
  pictureQuality: "vncPictureQuality",
  scaling: "vncScaling",
  preserveAspect: "vncPreserveAspect",
  shared: "vncShared",
  passSpecialKeys: "vncPassSpecialKeys",
  acceptBell: "vncAcceptBell",
  menuKey: "vncMenuKey",
  sendInitialClipboard: "vncSendInitialClipboard",
  warnUnencrypted: "vncWarnUnencrypted",
  autoReconnect: "vncAutoReconnect",
};

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Read viewer options from parsed session options (unknown values fall back). */
export function parseVncViewerOptions(options: Record<string, unknown> | null | undefined): VncViewerOptions {
  const source = options ?? {};
  const defaults = DEFAULT_VNC_VIEWER_OPTIONS;
  const quality = source[VNC_OPTION_KEYS.pictureQuality];
  const menuKey = source[VNC_OPTION_KEYS.menuKey];
  const scaling = source[VNC_OPTION_KEYS.scaling];
  return {
    pictureQuality: QUALITIES.includes(quality as VncPictureQuality)
      ? quality as VncPictureQuality
      : defaults.pictureQuality,
    scaling: scaling === undefined ? defaults.scaling : normalizeVncScaling(scaling),
    preserveAspect: readBoolean(source[VNC_OPTION_KEYS.preserveAspect], defaults.preserveAspect),
    shared: readBoolean(source[VNC_OPTION_KEYS.shared], defaults.shared),
    passSpecialKeys: readBoolean(source[VNC_OPTION_KEYS.passSpecialKeys], defaults.passSpecialKeys),
    acceptBell: readBoolean(source[VNC_OPTION_KEYS.acceptBell], defaults.acceptBell),
    menuKey: MENU_KEYS.includes(menuKey as VncMenuKey) ? menuKey as VncMenuKey : defaults.menuKey,
    sendInitialClipboard: readBoolean(
      source[VNC_OPTION_KEYS.sendInitialClipboard],
      defaults.sendInitialClipboard,
    ),
    warnUnencrypted: readBoolean(source[VNC_OPTION_KEYS.warnUnencrypted], defaults.warnUnencrypted),
    autoReconnect: readBoolean(source[VNC_OPTION_KEYS.autoReconnect], defaults.autoReconnect),
  };
}

/** Merge viewer options back into session options under their `vnc*` keys. */
export function writeVncViewerOptions(
  options: Record<string, unknown>,
  viewer: VncViewerOptions,
): Record<string, unknown> {
  const next = { ...options };
  (Object.keys(VNC_OPTION_KEYS) as Array<keyof VncViewerOptions>).forEach((key) => {
    next[VNC_OPTION_KEYS[key]] = viewer[key];
  });
  return next;
}

/** Bounded JSON form carried by detach claims. */
export function serializeVncViewerOptions(viewer: VncViewerOptions): string {
  return JSON.stringify(writeVncViewerOptions({}, viewer));
}

export function deserializeVncViewerOptions(raw: string | null | undefined): VncViewerOptions {
  if (!raw) return { ...DEFAULT_VNC_VIEWER_OPTIONS };
  try {
    const parsed: unknown = JSON.parse(raw);
    return parseVncViewerOptions(parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null);
  } catch {
    return { ...DEFAULT_VNC_VIEWER_OPTIONS };
  }
}

/** Wire value of the picture-quality control message (`[5, q]`). */
export function pictureQualityWire(quality: VncPictureQuality): number {
  return QUALITIES.indexOf(quality);
}

/** Options that only take effect on the next connection. */
export const VNC_RECONNECT_OPTIONS: ReadonlyArray<keyof VncViewerOptions> = ["shared"];
