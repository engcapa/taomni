import { emit } from "./tauri-event";

const BRIDGE_PATH = "/__newmob/sftp-bridge";
const HANDSHAKE_TIMEOUT_MS = 20000;
const COMMAND_TIMEOUT_MS = 60000;

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: number;
  transferId?: string;
}

interface SftpSession {
  ws: WebSocket;
  pending: Map<string, PendingRequest>;
  homeDir: string;
}

const sessions = new Map<string, SftpSession>();

function bridgeUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${BRIDGE_PATH}`;
}

function nextId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(bridgeUrl());
    const timer = window.setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error("WebSocket connection timeout"));
    }, HANDSHAKE_TIMEOUT_MS);
    ws.onopen = () => {
      window.clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      resolve(ws);
    };
    ws.onerror = () => {
      window.clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error("WebSocket connection failed"));
    };
  });
}

function attachHandlers(session: SftpSession) {
  session.ws.addEventListener("message", (ev) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    const id = msg.id as string | undefined;
    if (!id) return;
    const pending = session.pending.get(id);
    if (!pending) return;

    if (msg.type === "progress") {
      const transferId = pending.transferId;
      if (transferId) {
        void emit(`sftp-progress-${transferId}`, {
          bytes: Number(msg.bytes ?? 0),
          total: Number(msg.total ?? 0),
          rate: Number(msg.rate ?? 0),
          eta: Number(msg.eta ?? 0),
        });
      }
      return;
    }

    window.clearTimeout(pending.timer);
    session.pending.delete(id);
    if (msg.type === "error") {
      pending.reject(new Error(String(msg.message ?? "SFTP error")));
    } else {
      pending.resolve(msg);
    }
  });

  session.ws.addEventListener("close", () => {
    for (const p of session.pending.values()) {
      window.clearTimeout(p.timer);
      p.reject(new Error("SFTP connection closed"));
    }
    session.pending.clear();
    for (const [sid, sess] of sessions.entries()) {
      if (sess === session) {
        sessions.delete(sid);
        break;
      }
    }
  });
}

function request(
  sessionId: string,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number; transferId?: string } = {},
): Promise<Record<string, unknown>> {
  const session = sessions.get(sessionId);
  if (!session) return Promise.reject(new Error(`SFTP session not attached: ${sessionId}`));
  const id = nextId();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      session.pending.delete(id);
      reject(new Error("SFTP request timeout"));
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    session.pending.set(id, { resolve, reject, timer, transferId: options.transferId });
    try {
      session.ws.send(JSON.stringify({ id, ...payload }));
    } catch (err) {
      window.clearTimeout(timer);
      session.pending.delete(id);
      reject(err as Error);
    }
  });
}

export async function sftpAttach(args: {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
}): Promise<{ homeDir: string }> {
  if (sessions.has(args.sessionId)) {
    return { homeDir: sessions.get(args.sessionId)!.homeDir };
  }
  const ws = await openSocket();
  const session: SftpSession = { ws, pending: new Map(), homeDir: "/" };
  sessions.set(args.sessionId, session);
  attachHandlers(session);

  const id = nextId();
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      session.pending.delete(id);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      sessions.delete(args.sessionId);
      reject(new Error("SFTP handshake timeout"));
    }, HANDSHAKE_TIMEOUT_MS);
    session.pending.set(id, {
      resolve,
      reject: (err) => {
        sessions.delete(args.sessionId);
        try {
          ws.close();
        } catch {
          /* noop */
        }
        reject(err);
      },
      timer,
    });
    ws.send(
      JSON.stringify({
        id,
        type: "connect",
        host: args.host,
        port: args.port,
        username: args.username,
        authMethod: args.authMethod,
        authData: args.authData,
      }),
    );
  });
  session.homeDir = String(result.homeDir ?? "/");
  void emit(`sftp-attached-${args.sessionId}`, { homeDir: session.homeDir });
  return { homeDir: session.homeDir };
}

export async function sftpDetach(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    session.ws.send(JSON.stringify({ type: "close" }));
  } catch {
    /* noop */
  }
  try {
    session.ws.close();
  } catch {
    /* noop */
  }
  sessions.delete(sessionId);
}

export function isSftpSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export async function sftpListRemote(sessionId: string, path: string) {
  const r = await request(sessionId, { type: "list", path });
  return r.entries;
}

export async function sftpStatRemote(sessionId: string, path: string) {
  const r = await request(sessionId, { type: "stat", path });
  return r.entry;
}

export async function sftpMkdirRemote(sessionId: string, path: string) {
  await request(sessionId, { type: "mkdir", path });
}

export async function sftpRemoveRemote(sessionId: string, path: string, recursive: boolean) {
  await request(sessionId, { type: "remove", path, recursive });
}

export async function sftpRenameRemote(sessionId: string, oldPath: string, newPath: string) {
  await request(sessionId, { type: "rename", oldPath, newPath });
}

export async function sftpChmodRemote(sessionId: string, path: string, mode: number) {
  await request(sessionId, { type: "chmod", path, mode });
}

export async function sftpRealpathRemote(sessionId: string, path: string) {
  const r = await request(sessionId, { type: "realpath", path });
  return String(r.path ?? path);
}

export async function sftpReadTextRemote(
  sessionId: string,
  path: string,
  maxBytes: number,
): Promise<string> {
  const r = await request(sessionId, { type: "readtext", path, maxBytes });
  return String(r.contents ?? "");
}

export async function sftpWriteTextRemote(sessionId: string, path: string, contents: string) {
  await request(sessionId, { type: "writetext", path, contents });
}

export async function sftpUploadBytesRemote(
  sessionId: string,
  transferId: string,
  remotePath: string,
  bytesB64: string,
): Promise<void> {
  await request(
    sessionId,
    { type: "uploadbytes", path: remotePath, bytesB64 },
    { transferId, timeoutMs: 5 * 60 * 1000 },
  );
}

export async function sftpDownloadBytesRemote(
  sessionId: string,
  transferId: string,
  remotePath: string,
): Promise<string> {
  const r = await request(
    sessionId,
    { type: "downloadbytes", path: remotePath },
    { transferId, timeoutMs: 5 * 60 * 1000 },
  );
  return String(r.bytesB64 ?? "");
}

export function sftpCancel(sessionId: string, transferId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    session.ws.send(JSON.stringify({ id: nextId(), type: "cancel", transferId }));
  } catch {
    /* noop */
  }
}
