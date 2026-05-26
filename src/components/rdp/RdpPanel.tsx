import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize, Minimize, RefreshCw } from "lucide-react";

import {
  applyExtended,
  encodeAck,
  encodeKey,
  encodePing,
  encodePointer,
  encodeResize,
  keyEventToScancode,
  mouseButtonMask,
  OUT_FRAME,
  parseFrameTile,
  parseRdpWsText,
  rdpConnect,
  rdpDisconnect,
} from "../../lib/rdp";
import { useRdpStore } from "../../stores/rdpStore";
import type { RdpOptions } from "../../types/rdp";
import { useT, t as tr } from "../../lib/i18n";

export interface RdpPanelProps {
  tabId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  options: RdpOptions;
  networkSettingsJson?: string | null;
  visible: boolean;
}

type ScaleMode = "fit" | "one";

export default function RdpPanel({
  tabId,
  host,
  port,
  username,
  password,
  options,
  networkSettingsJson,
  visible,
}: RdpPanelProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const destroyedRef = useRef(false);
  const visibleRef = useRef(visible);
  const initRef = useRef({ host, port, username, password, options, networkSettingsJson });
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fit");
  const [fullscreen, setFullscreen] = useState(false);

  const store = useRdpStore();
  const conn = store.connections[tabId];

  /* ── Send helpers ────────────────────────────────────────────────── */

  const sendBinary = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  /* ── Connect lifecycle ───────────────────────────────────────────── */

  const doConnect = useCallback(() => {
    const args = initRef.current;
    destroyedRef.current = false;
    store.initConnection(tabId);

    let cancelled = false;
    (async () => {
      try {
        const result = await rdpConnect(
          args.host,
          args.port,
          args.username,
          args.password,
          args.options,
          args.networkSettingsJson ?? null,
        );
        if (cancelled || destroyedRef.current) {
          rdpDisconnect(result.session_id).catch(() => {});
          return;
        }
        sessionIdRef.current = result.session_id;
        store.setConnecting(tabId, result.session_id, result.ws_port);

        const ws = new WebSocket(`ws://127.0.0.1:${result.ws_port}`);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          if (heartbeatRef.current !== null) {
            window.clearInterval(heartbeatRef.current);
          }
          heartbeatRef.current = window.setInterval(() => {
            sendBinary(encodePing());
          }, 15000);
        };

        ws.onmessage = (event) => {
          if (destroyedRef.current) return;
          if (event.data instanceof ArrayBuffer) {
            const dv = new DataView(event.data);
            if (event.data.byteLength === 0) return;
            const tag = dv.getUint8(0);
            if (tag === OUT_FRAME) {
              const tile = parseFrameTile(event.data);
              if (tile) drawTile(canvasRef.current, tile);
              if (visibleRef.current) sendBinary(encodeAck());
            }
            // Other channels (audio / cursor / clipboard) are stubs in v0;
            // they land in steps 2/4/5 of the implementation plan.
          } else {
            const msg = parseRdpWsText(event.data as string);
            if (!msg) return;
            switch (msg.type) {
              case "connected":
                store.setConnected(tabId, msg.width, msg.height, msg.protocol, msg.server_name);
                resizeCanvas(canvasRef.current, msg.width, msg.height);
                break;
              case "disconnected":
                store.setDisconnected(tabId, msg.reason);
                break;
              case "status":
                store.setStage(tabId, msg.stage);
                break;
              case "error":
                store.setDisconnected(tabId, msg.message);
                break;
              case "clipboard":
                // Clipboard text from server — wire in step 4.
                break;
            }
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (heartbeatRef.current !== null) {
            window.clearInterval(heartbeatRef.current);
            heartbeatRef.current = null;
          }
          if (!destroyedRef.current) {
            store.setDisconnected(tabId, tr("rdp.closedConnection"));
          }
        };
        ws.onerror = () => {
          if (!destroyedRef.current) {
            store.setDisconnected(tabId, tr("rdp.websocketError"));
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
  }, [sendBinary, store, tabId]);

  useEffect(() => {
    initRef.current = { host, port, username, password, options, networkSettingsJson };
    let cancel: (() => void) | undefined;
    const t = window.setTimeout(() => {
      cancel = doConnect();
    }, 0);
    return () => {
      window.clearTimeout(t);
      cancel?.();
      destroyedRef.current = true;
      if (heartbeatRef.current !== null) {
        window.clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      const sid = sessionIdRef.current;
      if (sid) rdpDisconnect(sid).catch(() => {});
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      store.removeConnection(tabId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  /* ── Input handlers ──────────────────────────────────────────────── */

  const onKey = useCallback(
    (down: boolean) => (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const sc = keyEventToScancode(e.nativeEvent);
      if (!sc) return;
      e.preventDefault();
      sendBinary(encodeKey(down, applyExtended(sc.scancode, sc.extended)));
    },
    [conn?.status, sendBinary, visible],
  );

  const onPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(cssX * (canvas.width / rect.width))));
      const y = Math.max(
        0,
        Math.min(canvas.height - 1, Math.floor(cssY * (canvas.height / rect.height))),
      );
      sendBinary(encodePointer(x, y, mouseButtonMask(e.nativeEvent)));
    },
    [conn?.status, sendBinary, visible],
  );

  const triggerResize = useCallback(
    (w: number, h: number) => {
      sendBinary(encodeResize(w, h));
    },
    [sendBinary],
  );

  const reconnect = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) rdpDisconnect(sid).catch(() => {});
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    store.setDisconnected(tabId);
    doConnect();
  }, [doConnect, store, tabId]);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((f) => !f);
  }, []);

  /* ── Render ──────────────────────────────────────────────────────── */

  const status = conn?.status ?? "disconnected";
  const stage = conn?.stage;
  const dims = conn ? `${conn.width}×${conn.height}` : "";
  const protocol = conn?.protocol ?? "";

  const canvasClass = useMemo(
    () => (scaleMode === "fit" ? "rdp-canvas rdp-canvas-fit" : "rdp-canvas rdp-canvas-one"),
    [scaleMode],
  );

  return (
    <div
      ref={containerRef}
      className={`rdp-panel ${fullscreen ? "rdp-panel-fullscreen" : ""}`}
      data-testid="rdp-panel"
      tabIndex={0}
      onKeyDown={onKey(true)}
      onKeyUp={onKey(false)}
      style={{ outline: "none", position: "relative", width: "100%", height: "100%" }}
    >
      <div
        className="rdp-toolbar"
        style={{
          display: "flex",
          gap: 8,
          padding: 6,
          background: "var(--moba-toolbar-bg, #2b2b2b)",
          color: "var(--moba-text, #ddd)",
          fontSize: 12,
          alignItems: "center",
        }}
      >
        <span data-testid="rdp-status">{t(`rdp.status.${status}`)}</span>
        {protocol && <span style={{ opacity: 0.7 }}>· {protocol}</span>}
        {dims && <span style={{ opacity: 0.7 }}>· {dims}</span>}
        {stage && <span style={{ opacity: 0.5 }}>· {stage}</span>}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="moba-button"
          onClick={() => setScaleMode((m) => (m === "fit" ? "one" : "fit"))}
        >
          {scaleMode === "fit" ? t("rdp.scaleOne") : t("rdp.scaleFit")}
        </button>
        <button
          type="button"
          className="moba-button"
          onClick={() => triggerResize(conn?.width ?? 0, conn?.height ?? 0)}
          title={t("rdp.resize")}
        >
          {t("rdp.resize")}
        </button>
        <button type="button" className="moba-button" onClick={reconnect} title={t("rdp.reconnect")}>
          <RefreshCw size={14} />
        </button>
        <button type="button" className="moba-button" onClick={toggleFullscreen}>
          {fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
        </button>
      </div>

      <div
        style={{
          flex: 1,
          background: "#000",
          width: "100%",
          height: "calc(100% - 36px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <canvas
          ref={canvasRef}
          className={canvasClass}
          data-testid="rdp-canvas"
          width={Math.max(640, conn?.width ?? 1920)}
          height={Math.max(480, conn?.height ?? 1080)}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerUp={onPointer}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            maxWidth: scaleMode === "fit" ? "100%" : undefined,
            maxHeight: scaleMode === "fit" ? "100%" : undefined,
            imageRendering: "pixelated",
            background: "#000",
          }}
        />
      </div>

      {status !== "connected" && (
        <div
          className="rdp-overlay"
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            fontSize: 14,
          }}
        >
          {status === "connecting" && t("rdp.connecting")}
          {status === "disconnected" && t("rdp.disconnected")}
          {status === "error" && (conn?.error ?? t("rdp.errorGeneric"))}
        </div>
      )}
    </div>
  );
}

/* ── Canvas helpers ─────────────────────────────────────────────────── */

function resizeCanvas(canvas: HTMLCanvasElement | null, w: number, h: number) {
  if (!canvas) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function drawTile(
  canvas: HTMLCanvasElement | null,
  tile: { x: number; y: number; w: number; h: number; rgba: Uint8ClampedArray<ArrayBuffer> },
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // ImageData expects rgba length == 4*w*h. If the relay over-pads (which
  // shouldn't happen given the wire format), trim.
  const expected = 4 * tile.w * tile.h;
  if (tile.rgba.length < expected) return;
  const slice =
    tile.rgba.length === expected
      ? tile.rgba
      : (new Uint8ClampedArray(tile.rgba.buffer, tile.rgba.byteOffset, expected) as Uint8ClampedArray<ArrayBuffer>);
  const img = new ImageData(slice, tile.w, tile.h);
  ctx.putImageData(img, tile.x, tile.y);
}
