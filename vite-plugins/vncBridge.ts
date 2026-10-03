/**
 * RFB client + relay behind the browser-preview VNC bridge (vncProxy.ts).
 *
 * The desktop app connects through the Rust relay (src-tauri/src/vnc/ws.rs);
 * `pnpm dev` has no Rust backend, so this module speaks just enough RFB for
 * the same VncPanel WebSocket contract: None/VNCAuth security, Raw pixels,
 * DesktopSize, Bell, legacy cut text and ExtendedClipboard. It proves the
 * panel workflow against a real RFB server, not the native relay's
 * encodings, OS input or system clipboard.
 */
import net from "node:net";
import { constants as zlibConstants, deflateSync, inflateSync } from "node:zlib";
import { WebSocket, type RawData } from "ws";
import { vncAuthResponse } from "./vncDes";

const ENC_RAW = 0;
const ENC_DESKTOP_SIZE = -223;
const ENC_EXTENDED_CLIPBOARD = 0xc0a1e5ce | 0;

const CLIP_CAPS = 1 << 24;
const CLIP_REQUEST = 1 << 25;
const CLIP_PEEK = 1 << 26;
const CLIP_NOTIFY = 1 << 27;
const CLIP_PROVIDE = 1 << 28;
const FORMAT_TEXT = 1;
const FORMAT_RTF = 2;
const FORMAT_HTML = 4;
const OUR_FORMATS = FORMAT_TEXT | FORMAT_RTF | FORMAT_HTML;

const MAX_DIMENSION = 16_384;
const MAX_FRAMEBUFFER_BYTES = 256 * 1024 * 1024;
const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;
const MAX_REASON_BYTES = 4096;
const MAX_NAME_BYTES = 64 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 15_000;

export type VncStage =
  | "dns" | "tcp" | "proxy" | "rfb" | "security" | "authentication" | "initialization" | "runtime" | "relay";

/** Same shape as the Rust VncError, so `parseVncError` in the panel understands it. */
export interface VncBridgeError {
  code: string;
  stage: VncStage;
  retryable: boolean;
  message: string;
}

export class VncBridgeFailure extends Error {
  constructor(readonly detail: VncBridgeError) {
    super(detail.message);
  }
}

function fail(code: string, stage: VncStage, retryable: boolean, message: string): never {
  throw new VncBridgeFailure({ code, stage, retryable, message });
}

export interface VncBridgeRequest {
  host: string;
  port: number;
  password?: string | null;
  securityPolicy?: string | null;
  allowUnencrypted?: boolean | null;
  shared?: boolean | null;
  viewOnly?: boolean | null;
  clipboardPolicy?: string | null;
}

/** Buffered exact reads over a socket. */
export class SocketReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private waiter: (() => void) | null = null;
  private ended: Error | null = null;

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.size += chunk.length;
      this.wake();
    });
    const end = (error?: Error) => {
      this.ended ??= error ?? new Error("server closed the connection");
      this.wake();
    };
    socket.on("end", () => end());
    socket.on("close", () => end());
    socket.on("error", (error) => end(error));
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async read(n: number): Promise<Buffer> {
    while (this.size < n) {
      if (this.ended) throw this.ended;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    return out;
  }
}

export interface RfbConnection {
  socket: net.Socket;
  reader: SocketReader;
  width: number;
  height: number;
  name: string;
  protocol: string;
  security: string;
}

/** Mirror of the Rust `VncSecurityPolicy::choose` for the types this bridge speaks. */
export function chooseSecurity(offered: number[], policy: string | null | undefined): number {
  if (policy === "require-encryption") {
    fail("security-policy-unsupported", "security", false,
      "encrypted VNC is unavailable in the browser preview; run the desktop app");
  }
  if (offered.includes(2)) return 2;
  if (offered.includes(1) && policy === "allow-none") return 1;
  if (offered.includes(1)) {
    fail("security-policy-rejected", "security", false,
      "server offers unauthenticated VNC; enable allow-none explicitly to continue");
  }
  fail("security-policy-unsupported", "security", false,
    `the browser preview speaks only None and VNCAuth (server offers ${offered.join(", ") || "none"}); `
      + "run the desktop app for RA2/TLS");
}

async function readReason(reader: SocketReader): Promise<string> {
  const length = (await reader.read(4)).readUInt32BE(0);
  if (length > MAX_REASON_BYTES) fail("rfb-failed", "rfb", false, "VNC failure reason exceeds the limit");
  return (await reader.read(length)).toString("utf8");
}

/** Connect, negotiate security, authenticate and read ServerInit. */
export async function connectRfb(
  request: VncBridgeRequest,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  onSocket?: (socket: net.Socket) => void,
): Promise<RfbConnection> {
  const socket = net.connect({ host: request.host, port: request.port });
  socket.setNoDelay(true);
  onSocket?.(socket);
  const reader = new SocketReader(socket);
  const timer = setTimeout(() => socket.destroy(new Error("VNC handshake timed out")), timeoutMs);
  try {
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("connection closed")));
      });
    } catch (error) {
      fail("tcp-failed", "tcp", true,
        `TCP connect to ${request.host}:${request.port} failed: ${(error as Error).message}`);
    }

    const banner = (await reader.read(12)).toString("latin1");
    const version = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner);
    if (!version || Number(version[1]) < 3) {
      fail("rfb-failed", "rfb", false, `not an RFB server (${JSON.stringify(banner)})`);
    }
    // RealVNC announces 5.0 and accepts 3.8 clients.
    const offeredMinor = Number(version[1]) > 3 ? 8 : Number(version[2]);
    const minor = offeredMinor >= 8 ? 8 : offeredMinor >= 7 ? 7 : 3;
    socket.write(`RFB 003.00${minor}\n`);

    let chosen: number;
    if (minor === 3) {
      chosen = (await reader.read(4)).readUInt32BE(0);
      if (chosen === 0) fail("rfb-failed", "rfb", false, `server rejected connection: ${await readReason(reader)}`);
      chosen = chooseSecurity([chosen], request.securityPolicy);
    } else {
      const count = (await reader.read(1))[0];
      if (count === 0) fail("rfb-failed", "rfb", false, `server rejected connection: ${await readReason(reader)}`);
      chosen = chooseSecurity([...(await reader.read(count))], request.securityPolicy);
    }
    // RealVNC warns before any credential is exchanged (DEC-VNC-19); None and
    // VNCAuth are both unencrypted.
    if (request.allowUnencrypted === false) {
      fail("unencrypted-confirmation-required", "security", false,
        "unencrypted connection requires confirmation");
    }
    // DEC-VNC-21: without a password, stop before answering the challenge so
    // the panel can ask for one (RealVNC asks only when the server requires it).
    if (chosen === 2 && !request.password) {
      fail("credentials-required", "authentication", false,
        "credentials required: the server asks for a VNC password");
    }
    if (minor !== 3) socket.write(Buffer.from([chosen]));
    if (chosen === 2) {
      const challenge = await reader.read(16);
      socket.write(Buffer.from(vncAuthResponse(request.password ?? "", challenge)));
    }
    if (chosen === 2 || minor >= 8) {
      if ((await reader.read(4)).readUInt32BE(0) !== 0) {
        const reason = minor >= 8 ? await readReason(reader) : "";
        fail("authentication-failed", "authentication", false,
          reason ? `VNC authentication failed: ${reason}` : "VNC authentication failed");
      }
    }

    socket.write(Buffer.from([request.shared === false ? 0 : 1]));
    const init = await reader.read(24);
    const width = init.readUInt16BE(0);
    const height = init.readUInt16BE(2);
    const nameLength = init.readUInt32BE(20);
    if (nameLength > MAX_NAME_BYTES) fail("initialization-failed", "initialization", false, "desktop name exceeds the limit");
    const name = (await reader.read(nameLength)).toString("utf8");
    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION
      || width * height * 4 > MAX_FRAMEBUFFER_BYTES) {
      fail("initialization-failed", "initialization", false, `invalid framebuffer size ${width}x${height}`);
    }
    return {
      socket,
      reader,
      width,
      height,
      name,
      protocol: `RFB 003.00${minor}`,
      security: chosen === 2 ? "VNCAuth" : "None",
    };
  } catch (error) {
    socket.destroy();
    if (error instanceof VncBridgeFailure) throw error;
    const message = (error as Error).message;
    if (/timed out/.test(message)) fail("tcp-failed", "tcp", true, message);
    fail("rfb-failed", "rfb", false, `RFB handshake failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

interface ClipboardFormats {
  text?: string;
  html?: string;
  rtf?: string;
}

function formatMask(data: ClipboardFormats): number {
  return (data.text !== undefined ? FORMAT_TEXT : 0)
    | (data.rtf !== undefined ? FORMAT_RTF : 0)
    | (data.html !== undefined ? FORMAT_HTML : 0);
}

function filterFormats(data: ClipboardFormats, mask: number): ClipboardFormats {
  return {
    text: mask & FORMAT_TEXT ? data.text : undefined,
    rtf: mask & FORMAT_RTF ? data.rtf : undefined,
    html: mask & FORMAT_HTML ? data.html : undefined,
  };
}

function be32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

/** ExtendedClipboard provide body: per set format bit, u32 length + NUL-terminated UTF-8, zlib. */
export function buildProvideBody(data: ClipboardFormats): Buffer {
  const parts: Buffer[] = [];
  for (const [bit, value] of [[FORMAT_TEXT, data.text], [FORMAT_RTF, data.rtf], [FORMAT_HTML, data.html]] as const) {
    if (value === undefined) continue;
    const text = bit === FORMAT_TEXT ? value.replace(/\r?\n/g, "\r\n") : value;
    const bytes = Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]);
    parts.push(be32(bytes.length), bytes);
  }
  return Buffer.concat([be32(CLIP_PROVIDE | formatMask(data)), deflateSync(Buffer.concat(parts))]);
}

export function parseProvideBody(flags: number, payload: Buffer): ClipboardFormats {
  // TigerVNC's fresh per-message stream ends at Z_SYNC_FLUSH, without the
  // Z_FINISH trailer. Require the explicit flush boundary for that variant.
  const syncFlushed = payload.subarray(-4).equals(Buffer.from([0, 0, 0xff, 0xff]));
  const data = inflateSync(payload, {
    maxOutputLength: 2 * MAX_CLIPBOARD_BYTES,
    finishFlush: syncFlushed ? zlibConstants.Z_SYNC_FLUSH : zlibConstants.Z_FINISH,
  });
  const out: ClipboardFormats = {};
  let cursor = 0;
  for (let bit = 1; bit <= 0x8000; bit <<= 1) {
    if (!(flags & bit)) continue;
    if (cursor + 4 > data.length) throw new Error("truncated extended clipboard length");
    const length = data.readUInt32BE(cursor);
    cursor += 4;
    if (length > MAX_CLIPBOARD_BYTES || cursor + length > data.length) {
      throw new Error("truncated or oversized extended clipboard data");
    }
    let raw = data.subarray(cursor, cursor + length);
    cursor += length;
    if (raw.length && raw[raw.length - 1] === 0) raw = raw.subarray(0, raw.length - 1);
    const value = raw.toString("utf8");
    if (bit === FORMAT_TEXT) out.text = value.replace(/\r\n/g, "\n");
    else if (bit === FORMAT_RTF) out.rtf = value;
    else if (bit === FORMAT_HTML) out.html = value;
  }
  if (cursor !== data.length) throw new Error("extended clipboard data exceeds declared format lengths");
  return out;
}

function decodeLegacyCutText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

function asBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export interface VncBridgeSessionOptions {
  viewOnly: boolean;
  clipboardPolicy: string;
}

/**
 * One relay session. Like the native relay, a frame is the rectangles of one
 * FramebufferUpdate followed by an empty binary message; the next update is
 * requested only after the WebView ACKs the painted frame.
 */
export class VncBridgeSession {
  private ws: WebSocket | null = null;
  private closed = false;
  private width: number;
  private height: number;
  private generation = 0;
  private awaitingAck = false;
  private requestOutstanding = false;
  private refreshWanted = false;
  private serverClipboard = { formats: 0, actions: 0 };
  private latestLocal: ClipboardFormats | null = null;
  private window = { bytes: 0, updates: 0, frames: 0, updateMs: 0 };
  private windowStarted = performance.now();

  constructor(
    private readonly conn: RfbConnection,
    private readonly options: VncBridgeSessionOptions,
    private readonly onClosed: () => void = () => {},
  ) {
    this.width = conn.width;
    this.height = conn.height;
    conn.socket.on("close", () => {
      if (!this.closed) this.disconnect("connection-lost", "runtime", true, "the VNC server closed the connection");
    });
  }

  get name(): string {
    return this.conn.name;
  }

  attach(ws: WebSocket): void {
    this.ws = ws;
    ws.on("message", (data, isBinary) => this.onClientMessage(data, isBinary));
    ws.on("close", () => this.close());
    ws.on("error", () => this.close());
    this.sendJson({
      type: "connected",
      width: this.width,
      height: this.height,
      name: this.conn.name,
      protocol: this.conn.protocol,
      security: this.conn.security,
      encrypted: false,
    });
    // 32 bpp little-endian, red at bit 0: the bytes are R, G, B, X in memory.
    const pixelFormat = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
    const encodings = [ENC_RAW, ENC_DESKTOP_SIZE, ENC_EXTENDED_CLIPBOARD];
    const setEncodings = Buffer.alloc(4 + 4 * encodings.length);
    setEncodings[0] = 2;
    setEncodings.writeUInt16BE(encodings.length, 2);
    encodings.forEach((encoding, index) => setEncodings.writeInt32BE(encoding, 4 + 4 * index));
    this.write(Buffer.concat([pixelFormat, setEncodings]));
    this.requestUpdate(false);
    void this.readLoop();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.socket.destroy();
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    }
    this.onClosed();
  }

  private disconnect(code: string, stage: VncStage, retryable: boolean, reason: string): void {
    if (this.closed) return;
    this.sendJson({ type: "disconnected", code, stage, retryable, reason: reason.slice(0, 2048) });
    this.close();
  }

  private write(data: Buffer): void {
    if (!this.closed) this.conn.socket.write(data);
  }

  private sendJson(value: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(value));
  }

  private sendBinary(data: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  private allowsClientToServer(): boolean {
    return this.options.clipboardPolicy === "client-to-server" || this.options.clipboardPolicy === "bidirectional";
  }

  private allowsServerToClient(): boolean {
    return this.options.clipboardPolicy === "server-to-client" || this.options.clipboardPolicy === "bidirectional";
  }

  private requestUpdate(incremental: boolean): void {
    if (this.closed) return;
    if (this.requestOutstanding) {
      if (!incremental) this.refreshWanted = true;
      return;
    }
    if (!incremental) this.refreshWanted = false;
    this.requestOutstanding = true;
    const message = Buffer.alloc(10);
    message[0] = 3;
    message[1] = incremental ? 1 : 0;
    message.writeUInt16BE(this.width, 6);
    message.writeUInt16BE(this.height, 8);
    this.write(message);
  }

  private async readLoop(): Promise<void> {
    const reader = this.conn.reader;
    try {
      while (!this.closed) {
        const type = (await reader.read(1))[0];
        if (type === 0) {
          await this.readUpdate();
        } else if (type === 1) {
          const head = await reader.read(5);
          await reader.read(head.readUInt16BE(3) * 6);
        } else if (type === 2) {
          this.sendJson({ type: "bell" });
        } else if (type === 3) {
          await this.readCutText();
        } else {
          throw new VncBridgeFailure({ code: "rfb-failed", stage: "rfb", retryable: false,
            message: `unsupported server message ${type}` });
        }
      }
    } catch (error) {
      if (this.closed) return;
      if (error instanceof VncBridgeFailure) {
        const { code, stage, retryable, message } = error.detail;
        this.disconnect(code, stage, retryable, message);
      } else {
        this.disconnect("connection-lost", "runtime", true, (error as Error).message);
      }
    }
  }

  private async readUpdate(): Promise<void> {
    const reader = this.conn.reader;
    const started = performance.now();
    const count = (await reader.read(3)).readUInt16BE(1);
    for (let index = 0; index < count; index++) {
      const rect = await reader.read(12);
      const x = rect.readUInt16BE(0);
      const y = rect.readUInt16BE(2);
      const w = rect.readUInt16BE(4);
      const h = rect.readUInt16BE(6);
      const encoding = rect.readInt32BE(8);
      if (encoding === ENC_RAW) {
        const size = w * h * 4;
        if (x + w > this.width || y + h > this.height) {
          throw new VncBridgeFailure({ code: "rfb-failed", stage: "rfb", retryable: false,
            message: `rectangle ${w}x${h}+${x}+${y} outside the ${this.width}x${this.height} framebuffer` });
        }
        const pixels = await reader.read(size);
        if (!size) continue;
        const frame = Buffer.allocUnsafe(12 + size);
        frame.writeUInt16BE(x, 0);
        frame.writeUInt16BE(y, 2);
        frame.writeUInt16BE(w, 4);
        frame.writeUInt16BE(h, 6);
        frame.writeUInt32BE(0, 8);
        pixels.copy(frame, 12);
        for (let alpha = 15; alpha < frame.length; alpha += 4) frame[alpha] = 255;
        this.sendBinary(frame);
        this.window.bytes += 12 + size;
      } else if (encoding === ENC_DESKTOP_SIZE) {
        if (!w || !h || w > MAX_DIMENSION || h > MAX_DIMENSION || w * h * 4 > MAX_FRAMEBUFFER_BYTES) {
          throw new VncBridgeFailure({ code: "rfb-failed", stage: "rfb", retryable: false,
            message: `invalid desktop size ${w}x${h}` });
        }
        this.width = w;
        this.height = h;
        this.generation += 1;
        this.sendJson({ type: "desktop_size", width: w, height: h, generation: this.generation });
        this.refreshWanted = true;
      } else {
        throw new VncBridgeFailure({ code: "rfb-failed", stage: "rfb", retryable: false,
          message: `unsupported encoding ${encoding}` });
      }
    }
    this.requestOutstanding = false;
    this.window.updates += 1;
    this.window.updateMs += performance.now() - started;
    this.sendBinary(Buffer.alloc(0));
    this.awaitingAck = true;
    this.maybeSendStats();
  }

  private async readCutText(): Promise<void> {
    const length = (await this.conn.reader.read(7)).readInt32BE(3);
    if (Math.abs(length) > 2 * MAX_CLIPBOARD_BYTES) {
      throw new VncBridgeFailure({ code: "rfb-failed", stage: "rfb", retryable: false,
        message: "server clipboard exceeds the limit" });
    }
    const body = await this.conn.reader.read(Math.abs(length));
    if (length >= 0) {
      if (this.allowsServerToClient()) this.sendJson({ type: "clipboard", text: decodeLegacyCutText(body) });
      return;
    }
    if (body.length < 4) return;
    const flags = body.readUInt32BE(0);
    const action = (flags & 0xff000000) >>> 0;
    const formats = flags & 0xffff;
    if (action & CLIP_CAPS) {
      this.serverClipboard = { formats: formats & OUR_FORMATS, actions: action };
      const caps = Buffer.alloc(16);
      caps.writeUInt32BE((CLIP_CAPS | CLIP_REQUEST | CLIP_PEEK | CLIP_NOTIFY | CLIP_PROVIDE | OUR_FORMATS) >>> 0, 0);
      for (let index = 1; index <= 3; index++) caps.writeUInt32BE(MAX_CLIPBOARD_BYTES, 4 * index);
      this.writeExtendedClipboard(caps);
      this.sendJson({
        type: "ext_clipboard_support",
        available: (formats & OUR_FORMATS) !== 0 && (action & (CLIP_REQUEST | CLIP_NOTIFY | CLIP_PROVIDE)) !== 0,
      });
    } else if (action === CLIP_NOTIFY) {
      const wanted = formats & OUR_FORMATS;
      if (this.allowsServerToClient() && wanted && this.serverCan(CLIP_REQUEST)) {
        this.writeExtendedClipboard(be32(CLIP_REQUEST | wanted));
      }
    } else if (action === CLIP_PROVIDE) {
      if (this.allowsServerToClient()) {
        this.sendJson({ type: "ext_clipboard", ...parseProvideBody(formats, body.subarray(4)) });
      }
    } else if (action === CLIP_REQUEST) {
      const filtered = this.latestLocal && filterFormats(this.latestLocal, formats & OUR_FORMATS);
      if (this.allowsClientToServer() && filtered && formatMask(filtered)) {
        this.writeExtendedClipboard(buildProvideBody(filtered));
      }
    } else if (action === CLIP_PEEK && this.allowsClientToServer()) {
      const available = this.latestLocal ? formatMask(this.latestLocal) & OUR_FORMATS : 0;
      this.writeExtendedClipboard(be32(CLIP_NOTIFY | available));
    }
  }

  private serverCan(action: number): boolean {
    return this.serverClipboard.actions === 0 || (this.serverClipboard.actions & action) !== 0;
  }

  private writeExtendedClipboard(body: Buffer): void {
    const head = Buffer.alloc(8);
    head[0] = 6;
    head.writeInt32BE(-body.length, 4);
    this.write(Buffer.concat([head, body]));
  }

  private writeLegacyCutText(text: string): void {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_CLIPBOARD_BYTES) return;
    const head = Buffer.alloc(8);
    head[0] = 6;
    head.writeUInt32BE(bytes.length, 4);
    this.write(Buffer.concat([head, bytes]));
  }

  private sendLocalClipboard(data: ClipboardFormats): void {
    this.latestLocal = data;
    if (!this.serverClipboard.formats) {
      // No ExtendedClipboard caps: legacy ClientCutText (UTF-8, as the native relay sends).
      if (data.text !== undefined) this.writeLegacyCutText(data.text);
      return;
    }
    const filtered = filterFormats(data, this.serverClipboard.formats);
    const mask = formatMask(filtered);
    if (!mask) return;
    if (this.serverCan(CLIP_NOTIFY)) this.writeExtendedClipboard(be32(CLIP_NOTIFY | mask));
    else if (this.serverCan(CLIP_PROVIDE)) this.writeExtendedClipboard(buildProvideBody(filtered));
  }

  private onClientMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
      const message = asBuffer(data);
      if (!message.length) return;
      switch (message[0]) {
        case 0: // ACK: the WebView painted the frame
          if (this.awaitingAck) {
            this.awaitingAck = false;
            this.window.frames += 1;
            this.requestUpdate(!this.refreshWanted);
          }
          break;
        case 2: // key: down u8, keysym u32
          if (message.length >= 6 && !this.options.viewOnly) {
            const key = Buffer.alloc(8);
            key[0] = 4;
            key[1] = message[1] ? 1 : 0;
            key.writeUInt32BE(message.readUInt32BE(2), 4);
            this.write(key);
          }
          break;
        case 3: // pointer: buttons u8, x u16, y u16
          if (message.length >= 6 && !this.options.viewOnly) {
            const pointer = Buffer.alloc(6);
            pointer[0] = 5;
            pointer[1] = message[1];
            pointer.writeUInt16BE(message.readUInt16BE(2), 2);
            pointer.writeUInt16BE(message.readUInt16BE(4), 4);
            this.write(pointer);
          }
          break;
        case 4: // refresh: the WebView dropped pixels and will not ACK this frame
          this.awaitingAck = false;
          this.requestUpdate(false);
          break;
        default: // 1 ping, 5 picture quality (Raw only here)
          break;
      }
      return;
    }
    let message: { type?: unknown; text?: unknown; html?: unknown; rtf?: unknown };
    try {
      message = JSON.parse(asBuffer(data).toString("utf8"));
    } catch {
      return;
    }
    if (!this.allowsClientToServer()) return;
    const text = (value: unknown) => (typeof value === "string" ? value : undefined);
    if (message.type === "clipboard" && typeof message.text === "string") {
      this.writeLegacyCutText(message.text);
    } else if (message.type === "ext_clipboard") {
      this.sendLocalClipboard({ text: text(message.text), html: text(message.html), rtf: text(message.rtf) });
    }
  }

  /** Like the native relay: counters go out with an update once a second has passed. */
  private maybeSendStats(): void {
    const elapsed = performance.now() - this.windowStarted;
    if (elapsed < 1000) return;
    const seconds = elapsed / 1000;
    const { bytes, updates, frames, updateMs } = this.window;
    this.window = { bytes: 0, updates: 0, frames: 0, updateMs: 0 };
    this.windowStarted = performance.now();
    this.sendJson({
      type: "stats",
      requested_encoding: "Raw",
      last_encoding: "Raw",
      pixel_format: "32 bpp RGB888 (browser bridge)",
      wire_kbps: Math.round((bytes * 8) / 1000 / seconds),
      line_kbps: null,
      updates_per_sec: updates / seconds,
      frames_per_sec: frames / seconds,
      update_ms: updates ? updateMs / updates : 0,
    });
  }
}
