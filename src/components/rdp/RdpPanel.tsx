import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Expand,
  Fullscreen,
  Maximize2,
  Minimize2,
  PictureInPicture,
  PictureInPicture2,
  RefreshCw,
  Scan,
} from "lucide-react";

import {
  applyExtended,
  encodeAck,
  encodeKey,
  encodePing,
  encodePointer,
  encodeRefresh,
  encodeResize,
  encodeWheel,
  keyEventToScancode,
  mouseButtonMask,
  normalizeRdpResizeSize,
  OUT_AUDIO,
  OUT_FRAME,
  parseAudioFrame,
  parseFrameTile,
  parseRdpWsText,
  rdpConnect,
  rdpDisconnect,
  wheelDeltaToRotationUnits,
} from "../../lib/rdp";
import { useRdpStore } from "../../stores/rdpStore";
import type { RdpOptions } from "../../types/rdp";
import { useT, t as tr } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import {
  readFiles as readClipboardFiles,
  readText as readClipboardText,
  writeFiles as writeClipboardFiles,
  writeText as writeClipboardText,
} from "../../lib/clipboard";
import FloatingToolbar from "../floating-toolbar/FloatingToolbar";

export interface RdpPanelProps {
  tabId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  options: RdpOptions;
  networkSettingsJson?: string | null;
  visible: boolean;
  /** Callback for the toolbar Detach button. When undefined, the button
   *  is hidden — used by the detached window itself, which should show
   *  Reattach instead. */
  onDetach?: () => void;
  /** When provided the toolbar shows a maximize/restore toggle that the
   *  parent layout can use to hide the chrome around the panel. The RDP
   *  canvas still fills its parent — no `position: fixed` shenanigans. */
  onToggleMaximize?: () => void;
  maximized?: boolean;
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
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
  onDetach,
  onToggleMaximize,
  maximized,
  detachedWindowControls,
}: RdpPanelProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const audioRef = useRef<{ ctx: AudioContext; nextTime: number } | null>(null);
  const lastResizeRequestRef = useRef<string | null>(null);
  const destroyedRef = useRef(false);
  const visibleRef = useRef(visible);
  const suppressNextPasteKeyUpRef = useRef(false);
  const initRef = useRef({ host, port, username, password, options, networkSettingsJson });
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fit");
  // Local maximize fallback used only when the parent does NOT provide a
  // controlled `maximized` prop. Stays scoped to the panel — never
  // escapes the OS window.
  const [localMaximized, setLocalMaximized] = useState(false);
  const isMaximized = onToggleMaximize ? !!maximized : localMaximized;
  // Tracks whether the host OS window is fullscreen. Only meaningful for
  // attached tabs (detached windows manage their own fullscreen via
  // `detachedWindowControls`). Cosmetic — drives the toolbar icon.
  const [osFullscreen, setOsFullscreen] = useState(false);

  const store = useRdpStore();
  const conn = store.connections[tabId];

  /* ── Send helpers ────────────────────────────────────────────────── */

  const sendBinary = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const sendText = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const sendRemoteResize = useCallback(
    (width: number, height: number, force = false) => {
      const size = normalizeRdpResizeSize(width, height);
      if (!size) return;
      const key = `${size.width}x${size.height}`;
      if (!force && lastResizeRequestRef.current === key) return;
      lastResizeRequestRef.current = key;
      sendBinary(encodeResize(size.width, size.height));
    },
    [sendBinary],
  );

  const requestViewportResize = useCallback(
    (force = false) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      sendRemoteResize(rect.width, rect.height, force);
    },
    [sendRemoteResize],
  );

  const closeAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      void audio.ctx.close().catch(() => {});
    }
  }, []);

  const playAudioFrame = useCallback((frame: ReturnType<typeof parseAudioFrame>) => {
    if (!frame || initRef.current.options.redirectAudio !== "play") return;
    if (frame.channels < 1 || frame.channels > 2 || frame.bitsPerSample !== 16) return;

    const AudioContextCtor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    let audio = audioRef.current;
    if (!audio || audio.ctx.state === "closed") {
      audio = { ctx: new AudioContextCtor({ sampleRate: frame.sampleRate }), nextTime: 0 };
      audioRef.current = audio;
    }
    if (audio.ctx.state === "suspended") {
      void audio.ctx.resume().catch(() => {});
    }

    const bytesPerSample = frame.bitsPerSample / 8;
    const frameSize = bytesPerSample * frame.channels;
    const sampleCount = Math.floor(frame.pcm.byteLength / frameSize);
    if (sampleCount <= 0) return;

    const buffer = audio.ctx.createBuffer(frame.channels, sampleCount, frame.sampleRate);
    const view = new DataView(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength);
    for (let i = 0; i < sampleCount; i += 1) {
      for (let ch = 0; ch < frame.channels; ch += 1) {
        const offset = i * frameSize + ch * bytesPerSample;
        buffer.getChannelData(ch)[i] = view.getInt16(offset, true) / 32768;
      }
    }

    const source = audio.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.ctx.destination);
    const startAt = Math.max(audio.nextTime, audio.ctx.currentTime + 0.02);
    source.start(startAt);
    audio.nextTime = startAt + buffer.duration;
  }, []);

  /* ── Connect lifecycle ───────────────────────────────────────────── */

  const doConnect = useCallback(() => {
    const args = initRef.current;
    destroyedRef.current = false;
    lastResizeRequestRef.current = null;
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
            } else if (tag === OUT_AUDIO) {
              playAudioFrame(parseAudioFrame(event.data));
            }
          } else {
            const msg = parseRdpWsText(event.data as string);
            if (!msg) return;
            switch (msg.type) {
              case "connected":
                store.setConnected(tabId, msg.width, msg.height, msg.protocol, msg.server_name);
                resizeCanvas(canvasRef.current, msg.width, msg.height);
                window.setTimeout(() => requestViewportResize(false), 0);
                // Nudge the server to repaint the whole desktop shortly after
                // we (re)connect. Windows often hands us a stale framebuffer
                // across the logon→desktop transition; a Refresh Rect request
                // forces a fresh paint so the canvas is never stuck on the
                // pre-login image.
                window.setTimeout(() => sendBinary(encodeRefresh()), 400);
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
                void writeClipboardText(msg.text).catch((err) => {
                  console.warn("[rdp.clip] write local clipboard failed:", err);
                });
                break;
              case "clipboard_files":
                void writeClipboardFiles(msg.paths).catch((err) => {
                  console.warn("[rdp.clip] write local file clipboard failed:", err);
                  if ("text" in msg && typeof msg.text === "string") {
                    void writeClipboardText(msg.text).catch(() => {});
                  }
                });
                break;
            }
          }
        };

        ws.onclose = () => {
          closeAudio();
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
  }, [closeAudio, playAudioFrame, requestViewportResize, sendBinary, store, tabId]);

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
      closeAudio();
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

  const syncClipboardForRemotePaste = useCallback(async () => {
    const files = await readClipboardFiles().catch((err) => {
      console.warn("[rdp.clip] read local file clipboard failed:", err);
      return [];
    });
    if (files.length > 0) {
      sendText({ type: "clipboard_files", paths: files });
      window.setTimeout(() => {
        sendBinary(encodeKey(true, 0x1d)); // Ctrl
        sendBinary(encodeKey(true, 0x2f)); // V
        sendBinary(encodeKey(false, 0x2f));
        sendBinary(encodeKey(false, 0x1d));
      }, 40);
      return;
    }

    const text = await readClipboardText().catch((err) => {
      console.warn("[rdp.clip] read local clipboard failed:", err);
      return "";
    });
    if (!text) return;

    sendText({ type: "clipboard", text });
    window.setTimeout(() => {
      sendBinary(encodeKey(true, 0x1d)); // Ctrl
      sendBinary(encodeKey(true, 0x2f)); // V
      sendBinary(encodeKey(false, 0x2f));
      sendBinary(encodeKey(false, 0x1d));
    }, 40);
  }, [sendBinary, sendText]);

  /* ── View controls (local, never forwarded to the remote) ────────── */

  const toggleMaximize = useCallback(() => {
    if (onToggleMaximize) {
      onToggleMaximize();
    } else {
      setLocalMaximized((m) => !m);
    }
  }, [onToggleMaximize]);

  // Toggle the host OS window between fullscreen and normal. Detached
  // windows already own a fullscreen toggle (passed via
  // `detachedWindowControls`); attached tabs flip the main app window
  // directly through the Tauri window API, falling back to the DOM
  // Fullscreen API in browser dev mode.
  const toggleOsFullscreen = useCallback(() => {
    if (detachedWindowControls) {
      detachedWindowControls.onToggleOsFullscreen();
      return;
    }
    void (async () => {
      if (isTauriRuntime()) {
        try {
          const w = getCurrentWindow();
          const next = !(await w.isFullscreen());
          await w.setFullscreen(next);
          setOsFullscreen(next);
        } catch {
          /* window API unavailable — ignore */
        }
        return;
      }
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          setOsFullscreen(false);
        } else {
          await document.documentElement.requestFullscreen();
          setOsFullscreen(true);
        }
      } catch {
        /* fullscreen request rejected — ignore */
      }
    })();
  }, [detachedWindowControls]);

  const onKey = useCallback(
    (down: boolean) => (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const code = e.nativeEvent.code;

      // Local view shortcuts intercepted before reaching the remote desktop:
      //   F11               → toggle host-window OS fullscreen
      //   Ctrl/⌘+Alt+Enter  → toggle in-window maximize/restore
      if (code === "F11") {
        e.preventDefault();
        if (down && !e.nativeEvent.repeat) toggleOsFullscreen();
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.altKey &&
        (code === "Enter" || code === "NumpadEnter")
      ) {
        e.preventDefault();
        if (down && !e.nativeEvent.repeat) toggleMaximize();
        return;
      }

      if (!down && suppressNextPasteKeyUpRef.current && code === "KeyV") {
        suppressNextPasteKeyUpRef.current = false;
        e.preventDefault();
        return;
      }
      if (down && (e.ctrlKey || e.metaKey) && code === "KeyV") {
        e.preventDefault();
        suppressNextPasteKeyUpRef.current = true;
        void syncClipboardForRemotePaste();
        return;
      }
      const sc = keyEventToScancode(e.nativeEvent);
      if (!sc) return;
      e.preventDefault();
      sendBinary(encodeKey(down, applyExtended(sc.scancode, sc.extended)));
    },
    [
      conn?.status,
      sendBinary,
      syncClipboardForRemotePaste,
      toggleMaximize,
      toggleOsFullscreen,
      visible,
    ],
  );

  const onPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { x, y } = canvasPointFromClient(canvas, e.clientX, e.clientY);
      sendBinary(encodePointer(x, y, mouseButtonMask(e.nativeEvent)));
    },
    [conn?.status, sendBinary, visible],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (!visible || conn?.status !== "connected") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      e.preventDefault();
      const { x, y } = canvasPointFromClient(canvas, e.clientX, e.clientY);

      const verticalUnits = wheelDeltaToRotationUnits(e.deltaY, e.deltaMode);
      if (verticalUnits !== 0) {
        sendBinary(encodeWheel(x, y, -verticalUnits, true));
      }

      const horizontalUnits = wheelDeltaToRotationUnits(e.deltaX, e.deltaMode);
      if (horizontalUnits !== 0) {
        sendBinary(encodeWheel(x, y, horizontalUnits, false));
      }
    },
    [conn?.status, sendBinary, visible],
  );

  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;

    let timer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => requestViewportResize(false), 300);
    });
    observer.observe(viewport);
    requestViewportResize(false);

    return () => {
      observer.disconnect();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [conn?.status, requestViewportResize, visible]);

  const triggerResize = useCallback(() => {
    requestViewportResize(true);
  }, [requestViewportResize]);

  const refreshScreen = useCallback(() => {
    sendBinary(encodeRefresh());
  }, [sendBinary]);

  const reconnect = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) rdpDisconnect(sid).catch(() => {});
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    closeAudio();
    store.setDisconnected(tabId);
    doConnect();
  }, [closeAudio, doConnect, store, tabId]);

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
      className={`rdp-panel ${isMaximized ? "rdp-panel-maximized" : ""}`}
      data-testid="rdp-panel"
      tabIndex={0}
      onKeyDown={onKey(true)}
      onKeyUp={onKey(false)}
      style={{
        outline: "none",
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#000",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <FloatingToolbar
        storageKey="mob.rdp.toolbar"
        defaultTop={4}
        defaultRight={4}
        testId="rdp-floating-toolbar"
      >
        <span
          data-testid="rdp-status"
          style={{
            fontSize: 11,
            color: "#ddd",
            padding: "0 6px",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            whiteSpace: "nowrap",
          }}
        >
          {t(`rdp.status.${status}`)}
          {protocol && <span style={{ opacity: 0.65 }}>· {protocol}</span>}
          {dims && <span style={{ opacity: 0.65 }}>· {dims}</span>}
          {stage && <span style={{ opacity: 0.45 }}>· {stage}</span>}
        </span>
        <button
          type="button"
          data-testid="rdp-scale-toggle"
          onClick={() => setScaleMode((m) => (m === "fit" ? "one" : "fit"))}
          title={scaleMode === "fit" ? t("rdp.scaleOne") : t("rdp.scaleFit")}
          style={FT_BUTTON_STYLE}
        >
          {scaleMode === "fit" ? t("rdp.scaleOne") : t("rdp.scaleFit")}
        </button>
        <button
          type="button"
          data-testid="rdp-resize"
          disabled={conn?.status !== "connected"}
          onClick={triggerResize}
          title={t("rdp.resize")}
          aria-label={t("rdp.resize")}
          style={{ ...FT_ICON_BUTTON_STYLE, opacity: conn?.status === "connected" ? 1 : 0.5 }}
        >
          <Expand size={14} />
        </button>
        <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
        <button
          type="button"
          data-testid="rdp-refresh-screen"
          disabled={conn?.status !== "connected"}
          onClick={refreshScreen}
          title={t("rdp.refreshScreen")}
          aria-label={t("rdp.refreshScreen")}
          style={{ ...FT_ICON_BUTTON_STYLE, opacity: conn?.status === "connected" ? 1 : 0.5 }}
        >
          <Scan size={14} />
        </button>
        <button
          type="button"
          data-testid="rdp-reconnect"
          onClick={reconnect}
          title={t("rdp.reconnect")}
          aria-label={t("rdp.reconnect")}
          style={FT_ICON_BUTTON_STYLE}
        >
          <RefreshCw size={14} />
        </button>
        <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
        {onDetach && (
          <button
            type="button"
            data-testid="rdp-detach"
            onClick={onDetach}
            title={t("rdp.detach")}
            aria-label={t("rdp.detach")}
            style={FT_ICON_BUTTON_STYLE}
          >
            <PictureInPicture2 size={14} />
          </button>
        )}
        <button
          type="button"
          data-testid="rdp-maximize"
          onClick={toggleMaximize}
          title={`${isMaximized ? t("rdp.restore") : t("rdp.maximize")} (Ctrl+Alt+Enter)`}
          aria-label={isMaximized ? t("rdp.restore") : t("rdp.maximize")}
          style={FT_ICON_BUTTON_STYLE}
        >
          {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        {!detachedWindowControls && (
          <button
            type="button"
            data-testid="rdp-fullscreen"
            onClick={toggleOsFullscreen}
            title={`${t("rdp.osFullscreen")} (F11)`}
            aria-label={t("rdp.osFullscreen")}
            style={FT_ICON_BUTTON_STYLE}
          >
            {osFullscreen ? <Minimize2 size={14} /> : <Fullscreen size={14} />}
          </button>
        )}
        {detachedWindowControls && (
          <>
            <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
            <button
              type="button"
              data-testid="detached-reattach"
              onClick={detachedWindowControls.onReattach}
              title={t("rdp.reattach")}
              aria-label={t("rdp.reattach")}
              style={FT_BUTTON_STYLE}
            >
              <PictureInPicture size={14} />
              <span>{t("rdp.reattach")}</span>
            </button>
            <button
              type="button"
              data-testid="detached-os-fullscreen"
              onClick={detachedWindowControls.onToggleOsFullscreen}
              title={`${t("rdp.osFullscreen")} (F11)`}
              aria-label={t("rdp.osFullscreen")}
              style={FT_ICON_BUTTON_STYLE}
            >
              {detachedWindowControls.osFullscreen ? <Minimize2 size={14} /> : <Fullscreen size={14} />}
            </button>
          </>
        )}
      </FloatingToolbar>

      <div
        ref={viewportRef}
        style={{
          flex: 1,
          background: "#000",
          width: "100%",
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: scaleMode === "one" ? "auto" : "hidden",
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
          onWheel={onWheel}
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

const FT_BUTTON_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  padding: "3px 8px",
  background: "rgba(0,0,0,0.45)",
  color: "#ddd",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 4,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// Square icon-only button. Slightly larger hit area + centered glyph so the
// distinct lucide icons (reconnect / refresh-screen / detach / maximize…) are
// easy to tell apart at a glance.
const FT_ICON_BUTTON_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 24,
  padding: 0,
  background: "rgba(0,0,0,0.45)",
  color: "#ddd",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 4,
  cursor: "pointer",
};

// Thin vertical rule that visually groups related toolbar buttons.
const FT_SEPARATOR_STYLE: React.CSSProperties = {
  width: 1,
  alignSelf: "stretch",
  margin: "2px 2px",
  background: "rgba(255,255,255,0.18)",
};

/* ── Canvas helpers ─────────────────────────────────────────────────── */

function resizeCanvas(canvas: HTMLCanvasElement | null, w: number, h: number) {
  if (!canvas) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function canvasPointFromClient(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(cssX * (canvas.width / rect.width))));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(cssY * (canvas.height / rect.height))));
  return { x, y };
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
