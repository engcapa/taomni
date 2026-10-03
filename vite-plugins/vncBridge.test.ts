// @vitest-environment node
import { EventEmitter } from "node:events";
import net from "node:net";
import { constants as zlibConstants, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildProvideBody, connectRfb, parseProvideBody, VncBridgeFailure, VncBridgeSession } from "./vncBridge";
import { desEncryptBlock, vncAuthResponse } from "./vncDes";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("vncDes", () => {
  it("matches the FIPS 81 vector and the Python fixture's VNCAuth", () => {
    expect(hex(desEncryptBlock(Buffer.from("133457799BBCDFF1", "hex"), Buffer.from("0123456789ABCDEF", "hex"))))
      .toBe("85e813540f0ab405");
    const challenge = Uint8Array.from({ length: 16 }, (_, i) => i);
    expect(hex(vncAuthResponse("fxQa2610", challenge))).toBe("92ba8254f6a0353932e2701164d6c9b8");
    // Only the first 8 password bytes count.
    expect(hex(vncAuthResponse("QvAbc-_9longer", Uint8Array.from({ length: 16 }, (_, i) => i + 16))))
      .toBe("52a68616114e2b07647dbc9ec64f788d");
    expect(hex(vncAuthResponse("", new Uint8Array(16)))).toBe("8ca64de9c1b123a78ca64de9c1b123a7");
  });
});

/** Minimal scripted RFB 3.8 server. */
class FakeServer {
  readonly received: Buffer[] = [];
  private server = net.createServer();
  socket: net.Socket | null = null;
  chosen: number | null = null;
  port = 0;

  constructor(private readonly types: number[], private readonly password = "secret12") {}

  async start(): Promise<void> {
    this.server.on("connection", (socket: net.Socket) => {
      this.socket = socket;
      let stage = "version";
      let buffer = Buffer.alloc(0);
      const challenge = Buffer.alloc(16, 7);
      socket.write("RFB 003.008\n");
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (stage === "version" && buffer.length >= 12) {
            buffer = buffer.subarray(12);
            socket.write(Buffer.from([this.types.length, ...this.types]));
            stage = "type";
          } else if (stage === "type" && buffer.length >= 1) {
            const chosen = buffer[0];
            this.chosen = chosen;
            buffer = buffer.subarray(1);
            if (chosen === 2) {
              socket.write(challenge);
              stage = "auth";
            } else {
              socket.write(Buffer.alloc(4));
              stage = "init";
            }
          } else if (stage === "auth" && buffer.length >= 16) {
            const ok = Buffer.from(vncAuthResponse(this.password, challenge)).equals(buffer.subarray(0, 16));
            buffer = buffer.subarray(16);
            if (ok) {
              socket.write(Buffer.alloc(4));
              stage = "init";
            } else {
              const reason = Buffer.from("Authentication failed");
              const head = Buffer.alloc(8);
              head.writeUInt32BE(1, 0);
              head.writeUInt32BE(reason.length, 4);
              socket.end(Buffer.concat([head, reason]));
              return;
            }
          } else if (stage === "init" && buffer.length >= 1) {
            buffer = buffer.subarray(1);
            const name = Buffer.from("fake desktop");
            const init = Buffer.alloc(24);
            init.writeUInt16BE(4, 0);
            init.writeUInt16BE(2, 2);
            init.writeUInt32BE(name.length, 20);
            socket.write(Buffer.concat([init, name]));
            stage = "normal";
          } else if (stage === "normal" && buffer.length) {
            this.received.push(buffer);
            buffer = Buffer.alloc(0);
          } else {
            return;
          }
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  send(data: Buffer): void {
    this.socket!.write(data);
  }

  /** Every byte the client sent after ServerInit. */
  get stream(): Buffer {
    return Buffer.concat(this.received);
  }

  async stop(): Promise<void> {
    this.socket?.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

class FakeWs extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: (string | Buffer)[] = [];
  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
  get json(): Record<string, unknown>[] {
    return this.sent.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m));
  }
  get binary(): Buffer[] {
    return this.sent.filter((m): m is Buffer => Buffer.isBuffer(m));
  }
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

let servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
});

async function serve(types: number[], password?: string): Promise<FakeServer> {
  const server = new FakeServer(types, password);
  await server.start();
  servers.push(server);
  return server;
}

async function failure(promise: Promise<unknown>): Promise<VncBridgeFailure["detail"]> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VncBridgeFailure);
    return (error as VncBridgeFailure).detail;
  }
  throw new Error("expected a failure");
}

describe("connectRfb", () => {
  it("authenticates with VNCAuth and reads ServerInit", async () => {
    const server = await serve([2]);
    const conn = await connectRfb({ host: "127.0.0.1", port: server.port, password: "secret12" });
    expect([conn.width, conn.height, conn.name, conn.security, conn.protocol])
      .toEqual([4, 2, "fake desktop", "VNCAuth", "RFB 003.008"]);
    conn.socket.destroy();
  });

  it("reports a wrong password as an authentication failure", async () => {
    const server = await serve([2]);
    const detail = await failure(connectRfb({ host: "127.0.0.1", port: server.port, password: "wrong" }));
    expect(detail).toMatchObject({ code: "authentication-failed", stage: "authentication", retryable: false });
    expect(detail.message).toContain("Authentication failed");
  });

  it("asks for the unencrypted confirmation before sending credentials", async () => {
    const server = await serve([2]);
    const detail = await failure(connectRfb({ host: "127.0.0.1", port: server.port, password: "secret12",
      allowUnencrypted: false }));
    expect(detail.code).toBe("unencrypted-confirmation-required");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.chosen).toBeNull();
  });

  it("asks for credentials without answering the challenge when no password is given", async () => {
    const server = await serve([2]);
    const detail = await failure(connectRfb({ host: "127.0.0.1", port: server.port }));
    expect(detail).toMatchObject({ code: "credentials-required", stage: "authentication", retryable: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.chosen).toBeNull();
  });

  it("refuses an unauthenticated server unless allow-none is chosen", async () => {
    const server = await serve([1]);
    expect((await failure(connectRfb({ host: "127.0.0.1", port: server.port, securityPolicy: "prefer-encryption" }))).code)
      .toBe("security-policy-rejected");
    const conn = await connectRfb({ host: "127.0.0.1", port: server.port, securityPolicy: "allow-none" });
    expect(conn.security).toBe("None");
    conn.socket.destroy();
  });

  it("reports security types the bridge does not speak", async () => {
    const server = await serve([5, 6]);
    expect((await failure(connectRfb({ host: "127.0.0.1", port: server.port }))).code)
      .toBe("security-policy-unsupported");
  });

  it("classifies a refused TCP connection as retryable", async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    expect(await failure(connectRfb({ host: "127.0.0.1", port }))).toMatchObject({ code: "tcp-failed", retryable: true });
  });
});

describe("VncBridgeSession", () => {
  async function session(clipboardPolicy = "bidirectional", viewOnly = false) {
    const server = await serve([2]);
    const conn = await connectRfb({ host: "127.0.0.1", port: server.port, password: "secret12" });
    const ws = new FakeWs();
    const relay = new VncBridgeSession(conn, { viewOnly, clipboardPolicy });
    relay.attach(ws as unknown as WebSocket);
    // SetPixelFormat (20) + SetEncodings (16) + FramebufferUpdateRequest (10).
    await until(() => server.stream.length >= 46);
    return { server, ws, relay };
  }

  const rawUpdate = (x: number, y: number, w: number, h: number, rgbx: number[]) => {
    const head = Buffer.alloc(16);
    head.writeUInt16BE(1, 2);
    head.writeUInt16BE(x, 4);
    head.writeUInt16BE(y, 6);
    head.writeUInt16BE(w, 8);
    head.writeUInt16BE(h, 10);
    head.writeInt32BE(0, 12);
    return Buffer.concat([head, Buffer.from(rgbx)]);
  };

  it("relays Raw frames as RGBA rectangles and requests the next update after the ACK", async () => {
    const { server, ws, relay } = await session();
    expect(ws.json[0]).toMatchObject({ type: "connected", width: 4, height: 2, name: "fake desktop",
      security: "VNCAuth", encrypted: false });
    const stream = server.stream;
    expect([...stream.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(stream.readInt32BE(24)).toBe(0);
    expect(stream.readInt32BE(28)).toBe(-223);
    expect(stream.readInt32BE(32)).toBe(0xc0a1e5ce | 0);
    expect([...stream.subarray(36, 46)]).toEqual([3, 0, 0, 0, 0, 0, 0, 4, 0, 2]);

    server.send(rawUpdate(1, 1, 2, 1, [10, 20, 30, 0, 40, 50, 60, 0]));
    await until(() => ws.binary.length >= 2);
    const [rect, boundary] = ws.binary;
    expect([rect.readUInt16BE(0), rect.readUInt16BE(2), rect.readUInt16BE(4), rect.readUInt16BE(6), rect.readUInt32BE(8)])
      .toEqual([1, 1, 2, 1, 0]);
    expect([...rect.subarray(12)]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(boundary.length).toBe(0);

    const before = server.stream.length;
    ws.emit("message", Buffer.from([0]), true);
    await until(() => server.stream.length >= before + 10);
    expect([...server.stream.subarray(before, before + 2)]).toEqual([3, 1]);
    relay.close();
  });

  it("forwards keys and pointer, but not in view-only sessions", async () => {
    const { server, ws, relay } = await session();
    const before = server.stream.length;
    ws.emit("message", Buffer.from([2, 1, 0, 0, 0xff, 0xe3]), true);
    ws.emit("message", Buffer.from([3, 1, 0, 3, 0, 1]), true);
    await until(() => server.stream.length >= before + 14);
    expect([...server.stream.subarray(before)]).toEqual([4, 1, 0, 0, 0, 0, 0xff, 0xe3, 5, 1, 0, 3, 0, 1]);
    relay.close();

    const viewer = await session("bidirectional", true);
    const start = viewer.server.stream.length;
    viewer.ws.emit("message", Buffer.from([2, 1, 0, 0, 0, 0x61]), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(viewer.server.stream.length).toBe(start);
    viewer.relay.close();
  });

  it("announces a DesktopSize change and asks for a full update", async () => {
    const { server, ws, relay } = await session();
    const head = Buffer.alloc(16);
    head.writeUInt16BE(1, 2);
    head.writeUInt16BE(8, 8);
    head.writeUInt16BE(6, 10);
    head.writeInt32BE(-223, 12);
    server.send(head);
    await until(() => ws.json.some((m) => m.type === "desktop_size"));
    expect(ws.json.find((m) => m.type === "desktop_size")).toEqual({ type: "desktop_size", width: 8, height: 6, generation: 1 });
    const before = server.stream.length;
    ws.emit("message", Buffer.from([0]), true);
    await until(() => server.stream.length >= before + 10);
    expect([...server.stream.subarray(before, before + 10)]).toEqual([3, 0, 0, 0, 0, 0, 0, 8, 0, 6]);
    relay.close();
  });

  it("negotiates ExtendedClipboard both ways", async () => {
    const { server, ws, relay } = await session();
    const ext = (body: Buffer) => {
      const head = Buffer.alloc(8);
      head[0] = 3;
      head.writeInt32BE(-body.length, 4);
      return Buffer.concat([head, body]);
    };
    const caps = Buffer.alloc(12);
    caps.writeUInt32BE(((1 << 24) | (1 << 25) | (1 << 27) | (1 << 28) | 1 | 4) >>> 0, 0);
    server.send(ext(caps));
    await until(() => ws.json.some((m) => m.type === "ext_clipboard_support"));
    expect(ws.json.find((m) => m.type === "ext_clipboard_support")).toEqual({ type: "ext_clipboard_support", available: true });

    // Local copy: notify the formats the server takes, provide them on request.
    const notifyHead = Buffer.from([6, 0, 0, 0, 0xff, 0xff, 0xff, 0xfc]);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "ext_clipboard", text: "a\nb", html: "<b>x</b>", rtf: "{}" })), false);
    await until(() => server.stream.indexOf(notifyHead) >= 0);
    const notifyAt = server.stream.indexOf(notifyHead);
    await until(() => server.stream.length >= notifyAt + 12);
    expect(server.stream.readUInt32BE(notifyAt + 8)).toBe(((1 << 27) | 1 | 4) >>> 0);

    // The provide is the next client message; wait for all of it.
    let before = notifyAt + 12;
    const request = Buffer.alloc(4);
    request.writeUInt32BE(((1 << 25) | 1 | 4) >>> 0, 0);
    server.send(ext(request));
    await until(() => server.stream.length >= before + 8
      && server.stream.length >= before + 8 - server.stream.readInt32BE(before + 4));
    const provide = server.stream.subarray(before + 8);
    expect(parseProvideBody(provide.readUInt32BE(0) & 0xffff, provide.subarray(4)))
      .toEqual({ text: "a\nb", html: "<b>x</b>" });

    // Server copy: request on notify, deliver the provided formats.
    before = server.stream.length;
    const notifyFromServer = Buffer.alloc(4);
    notifyFromServer.writeUInt32BE(((1 << 27) | 1) >>> 0, 0);
    server.send(ext(notifyFromServer));
    await until(() => server.stream.length >= before + 12);
    expect(server.stream.readUInt32BE(before + 8)).toBe(((1 << 25) | 1) >>> 0);
    server.send(ext(buildProvideBody({ text: "服务器\r\n文本" })));
    await until(() => ws.json.some((m) => m.type === "ext_clipboard"));
    expect(ws.json.find((m) => m.type === "ext_clipboard")).toEqual({ type: "ext_clipboard", text: "服务器\n文本" });
    relay.close();
  });

  it("keeps the server clipboard local when the policy is client-to-server", async () => {
    const { server, ws, relay } = await session("client-to-server");
    const text = Buffer.from("remote");
    const head = Buffer.alloc(8);
    head[0] = 3;
    head.writeUInt32BE(text.length, 4);
    server.send(Buffer.concat([head, text]));
    server.send(Buffer.from([2]));
    await until(() => ws.json.some((m) => m.type === "bell"));
    expect(ws.json.some((m) => m.type === "clipboard")).toBe(false);
    relay.close();
  });

  it("reports a server that goes away as a retryable disconnect", async () => {
    const { server, ws } = await session();
    server.socket!.destroy();
    await until(() => ws.json.some((m) => m.type === "disconnected"));
    expect(ws.json.find((m) => m.type === "disconnected")).toMatchObject({ code: "connection-lost", stage: "runtime",
      retryable: true });
  });

  it("parses provide bodies with formats it does not keep", () => {
    const parts = [Buffer.from("hi\0"), Buffer.from("dib-bytes")];
    const payload = Buffer.concat(parts.flatMap((p) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(p.length, 0);
      return [length, p];
    }));
    expect(parseProvideBody(1 | 8, deflateSync(payload))).toEqual({ text: "hi" });
  });

  it("accepts TigerVNC sync-flushed clipboard data and rejects truncated format data", () => {
    const text = Buffer.from("LXQt 复制\r\n第二行\0");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(text.length);
    const packed = deflateSync(Buffer.concat([length, text]), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    expect(packed.subarray(-4)).toEqual(Buffer.from([0, 0, 0xff, 0xff]));
    expect(parseProvideBody(1, packed)).toEqual({ text: "LXQt 复制\n第二行" });
    expect(() => parseProvideBody(1, packed.subarray(0, -1))).toThrow();
    length.writeUInt32BE(text.length + 1);
    expect(() => parseProvideBody(1, deflateSync(Buffer.concat([length, text]), {
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
    }))).toThrow("truncated or oversized extended clipboard data");
  });
});
