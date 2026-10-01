/**
 * Browser-preview VNC bridge (`pnpm dev` only).
 *
 * The stubbed `vnc_connect` POSTs to `${VNC_BRIDGE_PATH}/connect`; this plugin
 * performs the RFB handshake (vncBridge.ts) and answers with the same
 * `VncConnectResult` the Rust backend returns. VncPanel then opens
 * `ws://127.0.0.1:<port>/vnc` with the `taomni-vnc.<token>` subprotocol, as it
 * does against the native relay; a token is single-use and expires when the
 * panel does not attach in time. Only the dev server's own origin reaches
 * these routes. Like the SSH bridge, target hosts follow the dev proxy's
 * private-address policy (devProxyDefaults.ts).
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type net from "node:net";
import type { Duplex } from "node:stream";
import type { Plugin, ViteDevServer } from "vite";
import { WebSocketServer } from "ws";
import { isBlockedTarget } from "./sshProxy";
import {
  connectRfb,
  VncBridgeFailure,
  VncBridgeSession,
  type VncBridgeError,
  type VncBridgeRequest,
} from "./vncBridge";

export const VNC_BRIDGE_PATH = "/__taomni/vnc-bridge";
/** Path and subprotocol prefix VncPanel uses for the relay WebSocket. */
const RELAY_PATH = "/vnc";
const PROTOCOL_PREFIX = "taomni-vnc.";
const ATTACH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;

interface ConnectBody extends VncBridgeRequest {
  attemptId?: string | null;
}

function readJson(req: IncomingMessage): Promise<ConnectBody & { session_id?: string }> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, value: object, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

function errorDetail(error: unknown): VncBridgeError {
  if (error instanceof VncBridgeFailure) return error.detail;
  return { code: "relay-failed", stage: "relay", retryable: true, message: (error as Error).message };
}

function pathOf(url: string | undefined): string {
  const path = (url ?? "").split("?")[0];
  return path.replace(/\/+$/, "") || "/";
}

function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function validTarget(body: ConnectBody): string | null {
  if (typeof body.host !== "string" || !body.host.trim()) return "VNC host is required";
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) return "VNC port must be 1-65535";
  const block = isBlockedTarget(body.host);
  return block.blocked ? `Target host is not permitted from the dev proxy: ${block.reason}` : null;
}

export function vncProxyPlugin(): Plugin {
  const pending = new Map<string, { session: VncBridgeSession; id: string; timer: ReturnType<typeof setTimeout> }>();
  const sessions = new Map<string, VncBridgeSession>();
  const attempts = new Map<string, net.Socket>();
  let wss: WebSocketServer | null = null;

  const connect = async (body: ConnectBody, wsPort: number) => {
    const target = validTarget(body);
    if (target) {
      throw new VncBridgeFailure({ code: "tcp-failed", stage: "tcp", retryable: false, message: target });
    }
    const attemptId = typeof body.attemptId === "string" ? body.attemptId : null;
    let conn;
    try {
      conn = await connectRfb(body, undefined, (socket) => {
        if (attemptId) attempts.set(attemptId, socket);
      });
    } catch (error) {
      if (attemptId && !attempts.has(attemptId)) {
        throw new VncBridgeFailure({ code: "connection-stopped", stage: "runtime", retryable: false,
          message: "attempt stopped by the user" });
      }
      throw error;
    } finally {
      if (attemptId) attempts.delete(attemptId);
    }
    const id = `vnc-browser-${randomBytes(8).toString("hex")}`;
    const token = randomBytes(24).toString("hex");
    const session = new VncBridgeSession(conn, {
      viewOnly: body.viewOnly === true,
      clipboardPolicy: body.clipboardPolicy ?? "bidirectional",
    }, () => {
      sessions.delete(id);
      const waiting = pending.get(token);
      if (waiting) clearTimeout(waiting.timer);
      pending.delete(token);
    });
    sessions.set(id, session);
    pending.set(token, { session, id, timer: setTimeout(() => session.close(), ATTACH_TIMEOUT_MS) });
    return { session_id: id, ws_port: wsPort, ws_token: token, width: conn.width, height: conn.height, name: conn.name };
  };

  return {
    name: "taomni-vnc-proxy",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      wss = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) => [...protocols].find((p) => p.startsWith(PROTOCOL_PREFIX)) ?? false,
      });

      server.middlewares.use(VNC_BRIDGE_PATH, (req, res) => {
        if (req.method !== "POST" || !isSameOrigin(req)) {
          reply(res, { ok: false, error: { code: "relay-failed", stage: "relay", retryable: false,
            message: "VNC bridge accepts same-origin POST requests only" } }, 403);
          return;
        }
        const route = pathOf(req.url);
        void readJson(req).then(async (body) => {
          if (route === "/connect") {
            const result = await connect(body, req.socket.localPort ?? server.config.server.port ?? 5000);
            reply(res, { ok: true, result });
          } else if (route === "/test") {
            const target = validTarget(body);
            if (target) throw new VncBridgeFailure({ code: "tcp-failed", stage: "tcp", retryable: false, message: target });
            const conn = await connectRfb({ ...body, allowUnencrypted: true });
            conn.socket.destroy();
            reply(res, { ok: true, result: `Connection successful: ${conn.width}x${conn.height} - ${conn.name}` });
          } else if (route === "/disconnect") {
            sessions.get(String(body.session_id))?.close();
            reply(res, { ok: true, result: null });
          } else if (route === "/cancel") {
            const socket = attempts.get(String(body.attemptId));
            attempts.delete(String(body.attemptId));
            socket?.destroy();
            reply(res, { ok: true, result: Boolean(socket) });
          } else {
            reply(res, { ok: false, error: { code: "relay-failed", stage: "relay", retryable: false,
              message: `unknown VNC bridge route ${route}` } }, 404);
          }
        }).catch((error: unknown) => reply(res, { ok: false, error: errorDetail(error) }));
      });

      server.httpServer?.on("upgrade", (req, socket, head) => {
        if (pathOf(req.url) !== RELAY_PATH) return;
        const offered = String(req.headers["sec-websocket-protocol"] ?? "")
          .split(",")
          .map((p) => p.trim())
          .find((p) => p.startsWith(PROTOCOL_PREFIX));
        const waiting = offered ? pending.get(offered.slice(PROTOCOL_PREFIX.length)) : undefined;
        if (!waiting) {
          socket.destroy();
          return;
        }
        pending.delete(offered!.slice(PROTOCOL_PREFIX.length));
        clearTimeout(waiting.timer);
        wss!.handleUpgrade(req, socket as Duplex, head, (ws) => waiting.session.attach(ws));
      });
    },
    closeBundle() {
      for (const session of sessions.values()) session.close();
      wss?.close();
      wss = null;
    },
  };
}

export default vncProxyPlugin;
