import { useEffect, useRef, useCallback, useState } from "react";
import {
  vncConnect,
  vncDisconnect,
  parseWsMessage,
  parseFrameHeader,
  keyEventToKeysym,
  mouseButtonMask,
} from "../../lib/vnc";
import type { WsOutgoing } from "../../lib/vnc";
import { useVncStore } from "../../stores/vncStore";
import { Maximize, Minimize, RefreshCw } from "lucide-react";

export interface VncPanelProps {
  tabId: string;
  host: string;
  port: number;
  password?: string;
  visible: boolean;
}

type ScaleMode = "fit" | "one";

export default function VncPanel({
  tabId,
  host,
  port,
  password,
  visible,
}: VncPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const frameBufferRef = useRef<Uint8Array[]>([]);
  const rafRef = useRef<number>(0);
  const destroyedRef = useRef(false);
  const connectArgsRef = useRef({ host, port, password });
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fit");

  const store = useVncStore();
  const conn = store.connections[tabId];

  const sendWs = useCallback((msg: WsOutgoing) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // ── connect logic, callable for retry ─────────────────────────────
  const doConnect = useCallback(() => {
    const { host: h, port: p, password: pw } = connectArgsRef.current;
    destroyedRef.current = false;
    store.initConnection(tabId);

    let cancelled = false;

    (async () => {
      try {
        const result = await vncConnect(h, p, pw);
        if (cancelled || destroyedRef.current) return;

        sessionIdRef.current = result.session_id;
        store.setConnecting(tabId, result.session_id, result.ws_port);

        const ws = new WebSocket(`ws://127.0.0.1:${result.ws_port}`);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onmessage = (event) => {
          if (destroyedRef.current) return;
          if (event.data instanceof ArrayBuffer) {
            const header = parseFrameHeader(event.data);
            if (!header) return;
            const rgba = new Uint8Array(event.data, 12);
            frameBufferRef.current.push(rgba);
          } else {
            const msg = parseWsMessage(event.data as string);
            if (!msg) return;
            switch (msg.type) {
              case "connected":
                store.setConnected(tabId, msg.width, msg.height, msg.name);
                break;
              case "disconnected":
                store.setDisconnected(tabId, msg.reason);
                break;
              case "clipboard":
                navigator.clipboard.writeText(msg.text).catch(() => {});
                break;
            }
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (!destroyedRef.current) {
            store.setDisconnected(tabId, "Connection closed");
          }
        };

        ws.onerror = () => {
          if (!destroyedRef.current) {
            store.setDisconnected(tabId, "WebSocket error");
          }
        };
      } catch (err) {
        if (!cancelled && !destroyedRef.current) {
          store.setDisconnected(tabId, String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [host, port, password, tabId, store]);

  // ── Mount / unmount ───────────────────────────────────────────────
  useEffect(() => {
    connectArgsRef.current = { host, port, password };
    const cancel = doConnect();

    return () => {
      cancel();
      destroyedRef.current = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      frameBufferRef.current = [];
      const sid = sessionIdRef.current;
      if (sid) {
        vncDisconnect(sid).catch(() => {});
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      store.removeConnection(tabId);
    };
  }, []);

  // ── Canvas rendering loop ────────────────────────────────────────
  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;
    const render = () => {
      if (!running || destroyedRef.current) return;

      const frames = frameBufferRef.current;
      if (frames.length > 0) {
        const rgba = frames[frames.length - 1];
        frames.length = 0;

        const pixelData = new Uint8ClampedArray(rgba.length);
        pixelData.set(rgba);

        if (canvas.width !== conn.width || canvas.height !== conn.height) {
          canvas.width = conn.width || 1;
          canvas.height = conn.height || 1;
        }

        const imgData = new ImageData(pixelData, conn.width || 1, conn.height || 1);
        try {
          ctx.putImageData(imgData, 0, 0);
        } catch {
          // size mismatch, skip
        }

        sendWs({ type: "ack" });
      }

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [visible, conn?.status, conn?.width, conn?.height, sendWs]);

  // ── Keyboard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
        return;
      const keysym = keyEventToKeysym(e);
      if (keysym === 0) return;
      e.preventDefault();
      sendWs({ type: "key", down: e.type === "keydown", keysym });
    };

    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);

    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text) sendWs({ type: "clipboard", text });
    };
    window.addEventListener("paste", handlePaste);

    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKey);
      window.removeEventListener("paste", handlePaste);
    };
  }, [visible, conn?.status, sendWs]);

  // ── Pointer ───────────────────────────────────────────────────────
  const getFbCoords = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const scaleX = conn.width / rect.width;
      const scaleY = conn.height / rect.height;
      return {
        x: Math.round((clientX - rect.left) * scaleX),
        y: Math.round((clientY - rect.top) * scaleY),
      };
    },
    [conn?.width, conn?.height],
  );

  const handlePointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (conn?.status !== "connected") return;
      const { x, y } = getFbCoords(e.clientX, e.clientY);
      const buttons = mouseButtonMask(e as unknown as MouseEvent);
      sendWs({ type: "pointer", x, y, buttons });
    },
    [conn?.status, getFbCoords, sendWs],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (conn?.status !== "connected") return;
      const { x, y } = getFbCoords(e.clientX, e.clientY);
      const wheelButton = e.deltaY < 0 ? 8 : 16;
      sendWs({ type: "pointer", x, y, buttons: wheelButton });
      setTimeout(() => sendWs({ type: "pointer", x, y, buttons: 0 }), 50);
    },
    [conn?.status, getFbCoords, sendWs],
  );

  // ── Resize → set_desktop_size ─────────────────────────────────────
  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;
    const container = containerRef.current;
    if (!container) return;

    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver((entries) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          sendWs({ type: "resize", width: Math.round(width), height: Math.round(height) });
        }
      }, 300);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [visible, conn?.status, sendWs]);

  // ── Canvas CSS size for scaling ───────────────────────────────────
  const canvasStyle: React.CSSProperties =
    scaleMode === "fit"
      ? {
          width: "100%",
          height: "100%",
          objectFit: "contain",
          cursor: "none",
        }
      : {
          width: conn?.width ?? 0,
          height: conn?.height ?? 0,
          cursor: "none",
          maxWidth: "none",
          maxHeight: "none",
        };

  // ── Render ───────────────────────────────────────────────────────
  const showCanvas = conn?.status === "connected";
  const showConnecting = conn?.status === "connecting";
  const showError =
    conn?.status === "disconnected" || conn?.status === "error";

  return (
    <div
      ref={containerRef}
      className="vnc-container"
      style={{
        width: "100%",
        height: "100%",
        overflow: scaleMode === "one" ? "auto" : "hidden",
        backgroundColor: "#1a1a2e",
        position: "relative",
      }}
    >
      {/* Scaling toolbar */}
      {showCanvas && (
        <div
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            zIndex: 10,
            display: "flex",
            gap: 4,
          }}
        >
          <button
            onClick={() => setScaleMode((m) => (m === "fit" ? "one" : "fit"))}
            style={{
              background: "rgba(0,0,0,0.5)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: 4,
              padding: 4,
              cursor: "pointer",
              color: "#ccc",
              display: "flex",
            }}
            title={scaleMode === "fit" ? "1:1 pixel mapping" : "Fit to window"}
          >
            {scaleMode === "fit" ? <Maximize size={14} /> : <Minimize size={14} />}
          </button>
        </div>
      )}

      {/* Status overlays */}
      {showConnecting && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.6)",
            zIndex: 5,
          }}
        >
          <div style={{ color: "#aaa", textAlign: "center" }}>
            <p>Connecting to {host}:{port}…</p>
          </div>
        </div>
      )}

      {showError && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.7)",
            zIndex: 5,
            gap: 12,
          }}
        >
          <div style={{ color: "#e44", textAlign: "center" }}>
            <p>Disconnected{conn?.error ? `: ${conn.error}` : ""}</p>
          </div>
          <button
            onClick={() => {
              // Cleanup old session
              const sid = sessionIdRef.current;
              if (sid) vncDisconnect(sid).catch(() => {});
              if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
              }
              // Reconnect
              doConnect();
            }}
            style={{
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.3)",
              borderRadius: 4,
              padding: "6px 16px",
              cursor: "pointer",
              color: "#ccc",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <RefreshCw size={14} />
            Reconnect
          </button>
        </div>
      )}

      <canvas
        ref={canvasRef}
        onPointerDown={handlePointer}
        onPointerMove={handlePointer}
        onPointerUp={handlePointer}
        onWheel={handleWheel}
        style={{
          display: showCanvas ? "block" : "none",
          ...canvasStyle,
        }}
        tabIndex={0}
      />
    </div>
  );
}
