import { invoke } from "@tauri-apps/api/core";
import { withVaultLockedNotice } from "./ipc";
import type { RdpOptions } from "../types/rdp";
import { serializeRdpOptions } from "../types/rdp";

export interface RdpConnectResult {
  session_id: string;
  ws_port: number;
}

/** Begin an RDP session. Returns the loopback WS port the canvas connects to. */
export async function rdpConnect(
  host: string,
  port: number,
  username: string | null | undefined,
  password: string | undefined,
  options: RdpOptions,
  networkSettingsJson: string | null = null,
): Promise<RdpConnectResult> {
  return withVaultLockedNotice(() =>
    invoke<RdpConnectResult>("rdp_connect", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
      optionsJson: serializeRdpOptions(options),
      networkSettingsJson,
    }),
  );
}

/** Close a session previously opened with `rdpConnect`. */
export async function rdpDisconnect(sessionId: string): Promise<void> {
  return invoke("rdp_disconnect", { sessionId });
}

/** Run the X.224 + Negotiation handshake without spawning the relay. */
export async function rdpTestConnection(
  host: string,
  port: number,
  username: string | null | undefined,
  password: string | undefined,
  options: RdpOptions,
  networkSettingsJson: string | null = null,
): Promise<string> {
  return withVaultLockedNotice(() =>
    invoke<string>("rdp_test_connection", {
      host,
      port,
      username: username?.trim() || null,
      password: password ?? null,
      optionsJson: serializeRdpOptions(options),
      networkSettingsJson,
    }),
  );
}

/* ── Binary WS framing ──────────────────────────────────────────────── */

/** Outbound channel tags (browser → relay). Mirrors `rdp/ws.rs::channel`. */
export const IN_PING = 0;
export const IN_ACK = 1;
export const IN_KEY = 2;
export const IN_POINTER = 3;
export const IN_RESIZE = 4;
export const IN_WHEEL = 5;
export const IN_REFRESH = 6;

/** Inbound channel tags (relay → browser). */
export const OUT_FRAME = 0;
export const OUT_AUDIO = 1;
export const OUT_CURSOR = 2;
export const OUT_CLIPBOARD_OFFER = 3;
export const OUT_CLIPBOARD_DATA = 4;
export const OUT_STATUS = 5;
export const OUT_FRAME_END = 6;

export type RdpWsText =
  | { type: "connected"; width: number; height: number; protocol: string; server_name: string }
  | { type: "disconnected"; reason: string }
  | { type: "status"; stage: string; detail: string }
  | { type: "clipboard"; text: string }
  | { type: "clipboard_files"; paths: string[]; text?: string }
  | { type: "error"; code: string; message: string };

export function parseRdpWsText(data: string): RdpWsText | null {
  try {
    return JSON.parse(data) as RdpWsText;
  } catch {
    return null;
  }
}

export function encodePing(): ArrayBuffer {
  return new Uint8Array([IN_PING]).buffer;
}

export function encodeAck(): ArrayBuffer {
  return new Uint8Array([IN_ACK]).buffer;
}

/** Ask the relay to request a full-desktop redraw from the RDP server. */
export function encodeRefresh(): ArrayBuffer {
  return new Uint8Array([IN_REFRESH]).buffer;
}

export function encodeKey(down: boolean, scancode: number): ArrayBuffer {
  const b = new Uint8Array(4);
  const v = new DataView(b.buffer);
  b[0] = IN_KEY;
  b[1] = down ? 1 : 0;
  v.setUint16(2, scancode & 0xffff);
  return b.buffer;
}

export function encodePointer(x: number, y: number, buttons: number): ArrayBuffer {
  const b = new Uint8Array(6);
  const v = new DataView(b.buffer);
  b[0] = IN_POINTER;
  b[1] = buttons & 0xff;
  v.setUint16(2, x & 0xffff);
  v.setUint16(4, y & 0xffff);
  return b.buffer;
}

export function encodeResize(width: number, height: number): ArrayBuffer {
  const b = new Uint8Array(5);
  const v = new DataView(b.buffer);
  b[0] = IN_RESIZE;
  v.setUint16(1, width & 0xffff);
  v.setUint16(3, height & 0xffff);
  return b.buffer;
}

export function encodeWheel(
  x: number,
  y: number,
  rotationUnits: number,
  isVertical = true,
): ArrayBuffer {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  b[0] = IN_WHEEL;
  b[1] = isVertical ? 0 : 1;
  v.setUint16(2, x & 0xffff);
  v.setUint16(4, y & 0xffff);
  v.setInt16(6, clampWheelRotationUnits(rotationUnits));
  return b.buffer;
}

export interface RdpResizeSize {
  width: number;
  height: number;
}

export function normalizeRdpResizeSize(width: number, height: number): RdpResizeSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const roundedWidth = Math.round(width);
  const roundedHeight = Math.round(height);
  if (roundedWidth <= 0 || roundedHeight <= 0) return null;

  let normalizedWidth = Math.max(200, Math.min(8192, roundedWidth));
  if (normalizedWidth % 2 !== 0) normalizedWidth -= 1;
  normalizedWidth = Math.max(200, normalizedWidth);

  const normalizedHeight = Math.max(200, Math.min(8192, roundedHeight));
  return { width: normalizedWidth, height: normalizedHeight };
}

export function wheelDeltaToRotationUnits(delta: number, deltaMode: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;

  const divisor = deltaMode === 1 ? 3 : deltaMode === 2 ? 1 : 120;
  const rawUnits = delta / divisor;
  const magnitude = Math.max(1, Math.round(Math.abs(rawUnits)));
  return clampWheelRotationUnits(Math.sign(delta) * magnitude);
}

function clampWheelRotationUnits(rotationUnits: number): number {
  if (!Number.isFinite(rotationUnits) || rotationUnits === 0) return 0;
  const rounded = Math.round(rotationUnits);
  return Math.max(-255, Math.min(255, rounded));
}

/**
 * Parse an inbound binary WS frame. The first byte is the channel tag;
 * the meaning of the rest depends on the tag.
 *
 * For FRAME messages, the payload is `[x(2), y(2), w(2), h(2), rgba…]`.
 */
export interface RdpFrameTile {
  tag: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface RdpAudioFrame {
  tag: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  timestamp: number;
  formatNo: number;
  pcm: Uint8Array<ArrayBuffer>;
}

export function parseFrameTile(data: ArrayBuffer): RdpFrameTile | null {
  if (data.byteLength < 9) return null;
  const dv = new DataView(data);
  const tag = dv.getUint8(0);
  if (tag !== OUT_FRAME) return null;
  const x = dv.getUint16(1);
  const y = dv.getUint16(3);
  const w = dv.getUint16(5);
  const h = dv.getUint16(7);
  const rgba = new Uint8ClampedArray(data, 9) as Uint8ClampedArray<ArrayBuffer>;
  return { tag, x, y, w, h, rgba };
}

export function parseAudioFrame(data: ArrayBuffer): RdpAudioFrame | null {
  if (data.byteLength < 17) return null;
  const dv = new DataView(data);
  const tag = dv.getUint8(0);
  if (tag !== OUT_AUDIO) return null;
  const sampleRate = dv.getUint32(1);
  const channels = dv.getUint16(5);
  const bitsPerSample = dv.getUint16(7);
  const timestamp = dv.getUint32(9);
  const formatNo = dv.getUint16(13);
  const pcm = new Uint8Array(data, 17) as Uint8Array<ArrayBuffer>;
  return { tag, sampleRate, channels, bitsPerSample, timestamp, formatNo, pcm };
}

/** Map a DOM `KeyboardEvent` to a (scancode, isExtended) pair. */
export function keyEventToScancode(
  e: KeyboardEvent,
): { scancode: number; extended: boolean } | null {
  // Letter keys: KeyA=0x1E … KeyZ=0x2C-ish. Use the DOM `code` map for
  // the common subset; printable characters fall through to charCodeAt
  // mapping as a fallback when `code` is unrecognized.
  const map: Record<string, [number, boolean]> = {
    Escape: [0x01, false],
    Backspace: [0x0e, false],
    Tab: [0x0f, false],
    Enter: [0x1c, false],
    NumpadEnter: [0x1c, true],
    ControlLeft: [0x1d, false],
    ControlRight: [0x1d, true],
    ShiftLeft: [0x2a, false],
    ShiftRight: [0x36, false],
    AltLeft: [0x38, false],
    AltRight: [0x38, true],
    MetaLeft: [0x5b, true],
    MetaRight: [0x5c, true],
    Space: [0x39, false],
    CapsLock: [0x3a, false],
    ArrowUp: [0x48, true],
    ArrowDown: [0x50, true],
    ArrowLeft: [0x4b, true],
    ArrowRight: [0x4d, true],
    Home: [0x47, true],
    End: [0x4f, true],
    PageUp: [0x49, true],
    PageDown: [0x51, true],
    Insert: [0x52, true],
    Delete: [0x53, true],
    KeyA: [0x1e, false],
    KeyB: [0x30, false],
    KeyC: [0x2e, false],
    KeyD: [0x20, false],
    KeyE: [0x12, false],
    KeyF: [0x21, false],
    KeyG: [0x22, false],
    KeyH: [0x23, false],
    KeyI: [0x17, false],
    KeyJ: [0x24, false],
    KeyK: [0x25, false],
    KeyL: [0x26, false],
    KeyM: [0x32, false],
    KeyN: [0x31, false],
    KeyO: [0x18, false],
    KeyP: [0x19, false],
    KeyQ: [0x10, false],
    KeyR: [0x13, false],
    KeyS: [0x1f, false],
    KeyT: [0x14, false],
    KeyU: [0x16, false],
    KeyV: [0x2f, false],
    KeyW: [0x11, false],
    KeyX: [0x2d, false],
    KeyY: [0x15, false],
    KeyZ: [0x2c, false],
    Digit0: [0x0b, false],
    Digit1: [0x02, false],
    Digit2: [0x03, false],
    Digit3: [0x04, false],
    Digit4: [0x05, false],
    Digit5: [0x06, false],
    Digit6: [0x07, false],
    Digit7: [0x08, false],
    Digit8: [0x09, false],
    Digit9: [0x0a, false],
    Minus: [0x0c, false],
    Equal: [0x0d, false],
    BracketLeft: [0x1a, false],
    BracketRight: [0x1b, false],
    Backslash: [0x2b, false],
    Semicolon: [0x27, false],
    Quote: [0x28, false],
    Backquote: [0x29, false],
    Comma: [0x33, false],
    Period: [0x34, false],
    Slash: [0x35, false],
    F1: [0x3b, false],
    F2: [0x3c, false],
    F3: [0x3d, false],
    F4: [0x3e, false],
    F5: [0x3f, false],
    F6: [0x40, false],
    F7: [0x41, false],
    F8: [0x42, false],
    F9: [0x43, false],
    F10: [0x44, false],
    F11: [0x57, false],
    F12: [0x58, false],
  };
  const entry = map[e.code];
  if (entry) return { scancode: entry[0], extended: entry[1] };
  return null;
}

/** Apply the extended-key flag to a scancode for the wire format. */
export function applyExtended(scancode: number, extended: boolean): number {
  return extended ? (scancode | 0x100) : scancode;
}

/** Mouse-button bitmask matching `ws.rs::PointerEvent::buttons`. */
export function mouseButtonMask(e: MouseEvent | PointerEvent): number {
  let m = 0;
  if (e.buttons & 1) m |= 0x01; // left
  if (e.buttons & 2) m |= 0x02; // right
  if (e.buttons & 4) m |= 0x04; // middle
  return m;
}
