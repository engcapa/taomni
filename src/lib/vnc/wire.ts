import { type WsIncoming } from "./model";
import { isVncStage, MAX_CURSOR_BASE64_CHARS, MAX_CURSOR_DIMENSION, MAX_RELAY_TEXT_CHARS, validClipboardFormats, validFramebufferSize, validStats } from "./validation";

/** Parse and minimally validate an incoming WS text message. */
export function parseWsMessage(data: string): WsIncoming | null {
  if (data.length > MAX_RELAY_TEXT_CHARS) return null;
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const msg = value as Record<string, unknown>;
    if (typeof msg.type !== "string") return null;
    switch (msg.type) {
      case "connected":
        return validFramebufferSize(msg.width, msg.height)
          && typeof msg.name === "string" && msg.name.length <= 64 * 1024
          && typeof msg.protocol === "string" && msg.protocol.length <= 128
          && typeof msg.security === "string" && msg.security.length <= 128
          && typeof msg.encrypted === "boolean"
          ? value as WsIncoming
          : null;
      case "desktop_size":
        return validFramebufferSize(msg.width, msg.height)
          && Number.isSafeInteger(msg.generation)
          && (msg.generation as number) > 0
          ? value as WsIncoming
          : null;
      case "pointer_pos":
        return Number.isInteger(msg.x)
          && Number.isInteger(msg.y)
          && (msg.x as number) >= 0
          && (msg.y as number) >= 0
          && (msg.x as number) <= 0xffff
          && (msg.y as number) <= 0xffff
          ? value as WsIncoming
          : null;
      case "disconnected":
        return typeof msg.code === "string" && msg.code.length <= 128
          && isVncStage(msg.stage)
          && typeof msg.retryable === "boolean"
          && typeof msg.reason === "string" && msg.reason.length <= 2048
          ? value as WsIncoming
          : null;
      case "bell":
        return value as WsIncoming;
      case "clipboard":
        return typeof msg.text === "string" && validClipboardFormats(msg.text)
          ? value as WsIncoming
          : null;
      case "ext_clipboard":
        return validClipboardFormats(msg.text, msg.html, msg.rtf)
          ? value as WsIncoming
          : null;
      case "ext_clipboard_support":
        return typeof msg.available === "boolean" ? value as WsIncoming : null;
      case "stats":
        return validStats(msg) ? value as WsIncoming : null;
      case "cursor": {
        if (typeof msg.visible !== "boolean") return null;
        if (msg.visible === false) {
          return msg.hotspot_x === 0 && msg.hotspot_y === 0
            && msg.width === 0 && msg.height === 0 && msg.png_base64 === ""
            ? value as WsIncoming
            : null;
        }
        const validGeometry = Number.isInteger(msg.hotspot_x)
          && Number.isInteger(msg.hotspot_y)
          && Number.isInteger(msg.width)
          && Number.isInteger(msg.height)
          && (msg.width as number) > 0
          && (msg.height as number) > 0
          && (msg.width as number) <= MAX_CURSOR_DIMENSION
          && (msg.height as number) <= MAX_CURSOR_DIMENSION
          && (msg.hotspot_x as number) >= 0
          && (msg.hotspot_y as number) >= 0
          && (msg.hotspot_x as number) < (msg.width as number)
          && (msg.hotspot_y as number) < (msg.height as number);
        const validPng = typeof msg.png_base64 === "string"
          && msg.png_base64.length > 0
          && msg.png_base64.length <= MAX_CURSOR_BASE64_CHARS
          && msg.png_base64.startsWith("iVBORw0KGgo")
          && /^[A-Za-z0-9+/]*={0,2}$/.test(msg.png_base64);
        return validGeometry && validPng ? value as WsIncoming : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function vncCursorToCss(cursor: Extract<WsIncoming, { type: "cursor"; }>): string {
  if (!cursor.visible) return "none";
  return `url("data:image/png;base64,${cursor.png_base64}") ${cursor.hotspot_x} ${cursor.hotspot_y}, default`;
}

export function encodeWsAck(): ArrayBuffer {
  return new Uint8Array([0]).buffer;
}

export function encodeWsPing(): ArrayBuffer {
  return new Uint8Array([1]).buffer;
}

export function encodeWsKey(down: boolean, keysym: number): ArrayBuffer {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  bytes[0] = 2;
  bytes[1] = down ? 1 : 0;
  view.setUint32(2, keysym >>> 0);
  return bytes.buffer;
}

export function encodeWsPointer(x: number, y: number, buttons: number): ArrayBuffer {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  bytes[0] = 3;
  bytes[1] = buttons & 0xff;
  view.setUint16(2, x & 0xffff);
  view.setUint16(4, y & 0xffff);
  return bytes.buffer;
}

export function encodeWsRefresh(): ArrayBuffer {
  return new Uint8Array([4]).buffer;
}

/** Picture quality control: 0 automatic, 1 high, 2 medium, 3 low. */
export function encodeWsQuality(quality: number): ArrayBuffer {
  return new Uint8Array([5, quality & 0xff]).buffer;
}

/** Parse a binary frame header: [x(2B), y(2B), w(2B), h(2B)] — all big-endian. */
export function parseFrameHeader(
  data: ArrayBuffer,
): { x: number; y: number; w: number; h: number; } | null {
  if (data.byteLength < 12) return null;
  const dv = new DataView(data);
  const x = dv.getUint16(0);
  const y = dv.getUint16(2);
  const w = dv.getUint16(4);
  const h = dv.getUint16(6);
  if (w === 0 || h === 0 || dv.getUint32(8) !== 0) return null;
  const expected = w * h * 4;
  if (!Number.isSafeInteger(expected) || data.byteLength !== 12 + expected) return null;
  return { x, y, w, h };
}
