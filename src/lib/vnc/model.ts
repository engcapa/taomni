export interface VncStructuredError {
  code: string;
  stage: "dns" | "tcp" | "proxy" | "rfb" | "security" | "authentication" | "initialization" | "runtime" | "relay";
  retryable: boolean;
  message: string;
}

export type VncSecurityPolicy =
  | "require-encryption"
  | "prefer-encryption"
  | "legacy-compatible"
  | "allow-none"
  /** RealVNC "Prefer off": unencrypted VNCAuth when offered. */
  | "prefer-off";

export type VncClipboardPolicy =
  | "disabled"
  | "client-to-server"
  | "server-to-client"
  | "bidirectional";

export interface VncConnectResult {
  session_id: string;
  ws_port: number;
  ws_token: string;
  width: number;
  height: number;
  name: string;
}

/** Connection-time viewer options (VNC-CONN-001 / VNC-SESS-003). */
export interface VncConnectExtras {
  pictureQuality?: "automatic" | "high" | "medium" | "low";
  shared?: boolean;
  /** False asks the backend to stop before authenticating over an unencrypted link. */
  allowUnencrypted?: boolean;
  /** Lets `vncCancelConnect` stop this attempt. */
  attemptId?: string;
}

export interface VncDetachClaim {
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  network_settings_json?: string | null;
  security_policy: VncSecurityPolicy;
  view_only: boolean;
  clipboard_policy: VncClipboardPolicy;
  /** Serialized viewer options (vncOptions.ts); absent in older claims. */
  viewer_options_json?: string | null;
}

/** WebSocket message types sent to the VNC relay. */
export type WsOutgoing =
  | { type: "ack"; }
  | { type: "ping"; }
  | { type: "key"; down: boolean; keysym: number; }
  | { type: "pointer"; x: number; y: number; buttons: number; }
  | { type: "clipboard"; text: string; }
  | {
    type: "ext_clipboard";
    text?: string;
    html?: string;
    rtf?: string;
  }
  | { type: "refresh"; }
  /** VNC-PERF-005: start (with the canvas box in viewport CSS px) or stop
   *  native cursor sampling; while on, plain moves are not sent from here. */
  | ({ type: "native_pointer"; on: true; } & VncNativePointerTarget)
  | { type: "native_pointer"; on: false; };

export interface VncNativePointerTarget {
  left: number;
  top: number;
  width: number;
  height: number;
  dpr: number;
  fb_width: number;
  fb_height: number;
}

/** WebSocket message types received from the VNC relay. */
export type WsIncoming =
  | {
    type: "connected";
    width: number;
    height: number;
    name: string;
    protocol: string;
    security: string;
    encrypted: boolean;
    /** The relay samples the cursor natively over the canvas (Windows). */
    native_pointer?: boolean;
  }
  | {
    type: "disconnected";
    code: string;
    stage: VncStructuredError["stage"];
    retryable: boolean;
    reason: string;
  }
  | { type: "bell"; }
  | { type: "desktop_size"; width: number; height: number; generation: number; }
  | { type: "pointer_pos"; x: number; y: number; }
  | { type: "clipboard"; text: string; }
  | {
    type: "ext_clipboard";
    text?: string;
    html?: string;
    rtf?: string;
  }
  | { type: "ext_clipboard_support"; available: boolean; }
  | ({ type: "stats"; } & VncSessionStats)
  | {
    type: "cursor";
    visible: boolean;
    hotspot_x: number;
    hotspot_y: number;
    width: number;
    height: number;
    png_base64: string;
  };

/** Once-per-second relay counters shown by Session Information. */
export interface VncSessionStats {
  requested_encoding: string;
  last_encoding: string;
  pixel_format: string;
  wire_kbps: number;
  line_kbps: number | null;
  updates_per_sec: number;
  frames_per_sec: number;
  update_ms: number;
  /** Picture quality preset and the tier it currently resolves to. */
  quality?: string;
  quality_level?: string;
}
