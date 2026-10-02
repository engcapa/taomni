/**
 * Browser-preview VNC commands, served by the dev-server bridge
 * (vite-plugins/vncProxy.ts). Results and errors keep the Rust command
 * shapes: `vnc_connect` resolves to a VncConnectResult whose relay WebSocket
 * VncPanel opens as usual, and failures reject with the structured VncError
 * JSON that `parseVncError` reads.
 */

const BRIDGE_PATH = "/__taomni/vnc-bridge";

type BridgeReply<T> = { ok: true; result: T } | { ok: false; error: unknown };

function relayError(message: string): Error {
  return new Error(JSON.stringify({ code: "relay-failed", stage: "relay", retryable: true, message }));
}

async function call<T>(route: string, body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BRIDGE_PATH}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw relayError(`VNC bridge unreachable: ${(error as Error).message}`);
  }
  const reply = (await response.json().catch(() => null)) as BridgeReply<T> | null;
  if (!reply) throw relayError(`VNC bridge answered HTTP ${response.status}`);
  if (!reply.ok) throw new Error(JSON.stringify(reply.error));
  return reply.result;
}

function connectBody(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    host: args?.host,
    port: args?.port,
    password: args?.password ?? null,
    securityPolicy: args?.securityPolicy ?? null,
    allowUnencrypted: args?.allowUnencrypted ?? null,
    shared: args?.shared ?? null,
    viewOnly: args?.viewOnly ?? false,
    clipboardPolicy: args?.clipboardPolicy ?? "bidirectional",
    attemptId: args?.attemptId ?? null,
  };
}

export function vncBridgeConnect<T>(args: Record<string, unknown> | undefined): Promise<T> {
  return call<T>("connect", connectBody(args));
}

export function vncBridgeTest<T>(args: Record<string, unknown> | undefined): Promise<T> {
  return call<T>("test", connectBody(args));
}

export function vncBridgeDisconnect(sessionId: unknown): Promise<null> {
  return call<null>("disconnect", { session_id: sessionId });
}

export function vncBridgeCancel(attemptId: unknown): Promise<boolean> {
  return call<boolean>("cancel", { attemptId });
}
