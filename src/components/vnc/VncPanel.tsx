import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import {
  vncConnect,
  vncDisconnect,
  encodeWsAck,
  encodeWsKey,
  encodeWsPing,
  encodeWsPointer,
  encodeWsRefresh,
  parseWsMessage,
  parseFrameHeader,
  parseVncError,
  vncCursorToCss,
  keyEventToKeysym,
  mapClientToFramebuffer,
  mouseButtonMask,
  computeVncDisplaySize,
  normalizeVncScaling,
  VncWheelAccumulator,
  VNC_KEYSYM,
} from "../../lib/vnc";
import type { VncScaling, VncSessionStats, WsOutgoing } from "../../lib/vnc";
import { buildVncSessionMenuItems } from "./vncSessionMenu";
import { VncSessionInfoDialog } from "./VncSessionInfoDialog";
import { useContextMenu } from "../ContextMenu";
import {
  VncPointerScheduler,
  type VncPointerState,
} from "../../lib/vncPointerScheduler";
import { useVncStore } from "../../stores/vncStore";
import { isEditableTarget, isTerminalFocused } from "../../lib/terminal/keyboardGuards";
import { useAppStore } from "../../stores/appStore";
import {
  ExternalLink,
  Maximize,
  Maximize2,
  Menu as MenuIcon,
  Minimize,
  Minimize2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useCaptureStore, type CaptureSource } from "../../stores/captureStore";
import { CaptureMenuButton } from "../capture/CaptureMenuButton";
import { TabActions } from "../tabbar/TabActionSlot";
import {
  FT_BUTTON_STYLE,
  FT_ICON_BUTTON_STYLE,
  FT_SEPARATOR_STYLE,
} from "../floating-toolbar/floatingToolbarStyles";
import { captureCanvasPng } from "../../lib/capture";
import {
  readText as readClipboardText,
  readMultiFormat,
  writeMultiFormat,
  writeText as writeClipboardText,
} from "../../lib/clipboard";
import { useT, t as tr } from "../../lib/i18n";

export interface VncPanelProps {
  tabId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  networkSettingsJson?: string | null;
  securityPolicy?: "require-encryption" | "prefer-encryption" | "legacy-compatible" | "allow-none";
  viewOnly?: boolean;
  clipboardPolicy?: "disabled" | "client-to-server" | "server-to-client" | "bidirectional";
  /** Initial viewer scaling ("auto", "fit", "fit-width", "fit-height" or a percentage). */
  initialScaling?: VncScaling | string;
  visible: boolean;
  onDetach?: () => void;
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
}

const PASTE_KEY_DELAY_MS = 120;
/** Upper bound a middle click waits for an in-flight clipboard sync (X11 paste). */
const MIDDLE_CLICK_CLIPBOARD_WAIT_MS = 150;
const MAX_PENDING_RECTS = 4096;
const MAX_PENDING_FRAME_BYTES = 128 * 1024 * 1024;
const CLIPBOARD_SYNC_INTERVAL_MS = 750;
const CLIPBOARD_SYNC_MIN_INTERVAL_MS = 250;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAYS_MS = [750, 1500, 3000] as const;
const RECONNECT_STABLE_MS = 30_000;
type PendingFrame = {
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
};
type DelayedPointerDown = {
  pointerId: number;
  down: VncPointerState;
  up: VncPointerState | null;
};

function modifierKeysymFromKey(key: string): number | null {
  switch (key) {
    case "Shift":
      return 0xffe1;
    case "Control":
      return 0xffe3;
    case "Alt":
      return 0xffe9;
    case "Meta":
      return 0xffeb;
    default:
      return null;
  }
}

function pasteModifierKeysyms(e: KeyboardEvent): Set<number> {
  const keysyms = new Set<number>();
  if (e.shiftKey) keysyms.add(0xffe1);
  if (e.ctrlKey) keysyms.add(0xffe3);
  if (e.altKey) keysyms.add(0xffe9);
  if (e.metaKey) keysyms.add(0xffeb);
  return keysyms;
}

function isPasteShortcut(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V");
}

function hasNonAsciiText(text: string): boolean {
  return /[^\x00-\x7f]/.test(text);
}

export default function VncPanel({
  tabId,
  host,
  port,
  username,
  password,
  networkSettingsJson,
  securityPolicy,
  viewOnly = false,
  clipboardPolicy = "bidirectional",
  initialScaling = "auto",
  visible,
  onDetach,
  detachedWindowControls,
}: VncPanelProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const frameBufferRef = useRef<PendingFrame[]>([]);
  const pendingFrameBytesRef = useRef(0);
  const dropFrameUntilBoundaryRef = useRef(false);
  const framebufferSizeRef = useRef({ width: 0, height: 0 });
  const framebufferGenerationRef = useRef(0);
  const pressedKeysymsRef = useRef(new Set<number>());
  const rafRef = useRef<number>(0);
  const destroyedRef = useRef(false);
  const suppressReconnectRef = useRef(false);
  const connectArgsRef = useRef({
    host,
    port,
    username,
    password,
    networkSettingsJson,
    securityPolicy,
    viewOnly,
    clipboardPolicy,
  });
  const heartbeatTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectStableTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectGenerationRef = useRef(0);
  const visibleRef = useRef(visible);
  const ackPendingRef = useRef(false);
  const pasteDelayTimerRef = useRef<number | null>(null);
  const pointerSchedulerRef = useRef<VncPointerScheduler | null>(null);
  const lastPointerSentRef = useRef<VncPointerState | null>(null);
  const delayedPointerDownRef = useRef<DelayedPointerDown | null>(null);
  const clipboardSyncPromiseRef = useRef<Promise<void> | null>(null);
  const serverClipboardWriteInFlightRef = useRef(0);
  const lastClipboardSyncCheckAtRef = useRef(0);
  const lastSyncedLocalClipboardTextRef = useRef<string | null>(null);
  const pasteInFlightRef = useRef<{
    pasteKeysym: number;
    heldModifiers: Set<number>;
    deferredKeyUps: Set<number>;
  } | null>(null);
  // Tracks whether the connected server negotiated the ExtendedClipboard
  // pseudo-encoding. Stored as a ref so input handlers read the latest value
  // without re-binding.
  const extClipboardSupportedRef = useRef<boolean>(false);
  const cursorShapeReceivedRef = useRef(false);
  const [scaling, setScaling] = useState<VncScaling>(() => normalizeVncScaling(initialScaling));
  const [preserveAspect, setPreserveAspect] = useState(true);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [devicePixelRatio, setDevicePixelRatio] = useState(() => window.devicePixelRatio || 1);
  const [fullScreen, setFullScreen] = useState(false);
  const [ctrlLatched, setCtrlLatched] = useState(false);
  const [altLatched, setAltLatched] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [sessionStats, setSessionStats] = useState<VncSessionStats | null>(null);
  const wheelAccumulatorRef = useRef(new VncWheelAccumulator());
  // True once the WebView delivers pointerrawupdate for this canvas.
  const rawPointerMovesRef = useRef(false);
  const [remoteCursorCss, setRemoteCursorCss] = useState("none");
  const allowClipboardSend = clipboardPolicy === "bidirectional" || clipboardPolicy === "client-to-server";
  const allowClipboardReceive = clipboardPolicy === "bidirectional" || clipboardPolicy === "server-to-client";

  // Actions are stable; subscribe to this tab's connection only so another
  // session's state change does not re-render this canvas.
  const store = useMemo(() => useVncStore.getState(), []);
  const conn = useVncStore((s) => s.connections[tabId]);
  const sessionMenu = useContextMenu();

  const sendWs = useCallback((msg: WsOutgoing) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendWsBinary = useCallback((data: ArrayBuffer): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
      return true;
    }
    return false;
  }, []);

  const requestFullRefresh = useCallback(() => {
    sendWsBinary(encodeWsRefresh());
  }, [sendWsBinary]);

  // ── Session menu actions (F8 menu / toolbar) ──────────────────────
  const latchedKeysymsRef = useRef(new Set<number>());

  const setKeyLatched = useCallback((keysym: number, latched: boolean) => {
    if (latched === latchedKeysymsRef.current.has(keysym)) return;
    if (latched) latchedKeysymsRef.current.add(keysym);
    else latchedKeysymsRef.current.delete(keysym);
    sendWsBinary(encodeWsKey(latched, keysym));
    if (keysym === VNC_KEYSYM.controlL) setCtrlLatched(latched);
    if (keysym === VNC_KEYSYM.altL) setAltLatched(latched);
  }, [sendWsBinary]);

  const sendKeyCombo = useCallback((keysyms: number[]) => {
    if (viewOnly) return;
    // Modifiers already latched by the Ctrl/Alt menu items stay held.
    const pressed = keysyms.filter((keysym) => !latchedKeysymsRef.current.has(keysym));
    pressed.forEach((keysym) => sendWsBinary(encodeWsKey(true, keysym)));
    [...pressed].reverse().forEach((keysym) => sendWsBinary(encodeWsKey(false, keysym)));
  }, [sendWsBinary, viewOnly]);

  const sendCtrlAltDel = useCallback(() => {
    sendKeyCombo([VNC_KEYSYM.controlL, VNC_KEYSYM.altL, VNC_KEYSYM.delete]);
  }, [sendKeyCombo]);

  const canFullScreen = Boolean(detachedWindowControls)
    || (typeof document !== "undefined" && typeof document.documentElement?.requestFullscreen === "function");

  const toggleFullScreen = useCallback(() => {
    if (detachedWindowControls) {
      detachedWindowControls.onToggleOsFullscreen();
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement === container) {
      void document.exitFullscreen?.().catch(() => {});
    } else {
      void container.requestFullscreen?.().catch(() => {});
    }
  }, [detachedWindowControls]);

  useEffect(() => {
    const onChange = () => setFullScreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const closeConnection = useCallback(() => {
    suppressReconnectRef.current = true;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    latchedKeysymsRef.current.clear();
    setCtrlLatched(false);
    setAltLatched(false);
    const sid = sessionIdRef.current;
    sessionIdRef.current = null;
    if (sid) void vncDisconnect(sid).catch(() => {});
    wsRef.current?.close();
    wsRef.current = null;
    store.setDisconnected(tabId, tr("vnc.closedConnection"));
  }, [store, tabId]);

  const openSessionMenu = useCallback((x?: number, y?: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const left = x ?? (rect ? rect.left + rect.width / 2 - 110 : 100);
    const top = y ?? (rect ? rect.top + Math.max(40, rect.height / 4) : 100);
    sessionMenu.showAt(left, top, buildVncSessionMenuItems(
      {
        fullScreen: detachedWindowControls ? detachedWindowControls.osFullscreen : fullScreen,
        canFullScreen,
        viewOnly,
        ctrlLatched,
        altLatched,
        scaling,
        preserveAspect,
      },
      {
        toggleFullScreen,
        sendF8: () => sendKeyCombo([VNC_KEYSYM.f8]),
        sendCtrlAltDel,
        toggleCtrl: () => setKeyLatched(VNC_KEYSYM.controlL, !latchedKeysymsRef.current.has(VNC_KEYSYM.controlL)),
        toggleAlt: () => setKeyLatched(VNC_KEYSYM.altL, !latchedKeysymsRef.current.has(VNC_KEYSYM.altL)),
        setScaling,
        togglePreserveAspect: () => setPreserveAspect((value) => !value),
        refreshScreen: requestFullRefresh,
        showSessionInfo: () => setInfoOpen(true),
        closeConnection,
      },
      tr,
    ));
  }, [
    altLatched, canFullScreen, closeConnection, ctrlLatched, detachedWindowControls, fullScreen,
    preserveAspect, requestFullRefresh, scaling, sendCtrlAltDel, sendKeyCombo, sessionMenu,
    setKeyLatched, toggleFullScreen, viewOnly,
  ]);
  const openSessionMenuRef = useRef(openSessionMenu);
  openSessionMenuRef.current = openSessionMenu;

  const syncLocalClipboardToServer = useCallback(
    (reason: string, force = false): Promise<void> => {
      if (!allowClipboardSend || destroyedRef.current || wsRef.current?.readyState !== WebSocket.OPEN) {
        return Promise.resolve();
      }
      if (serverClipboardWriteInFlightRef.current > 0) {
        return Promise.resolve();
      }

      const now = Date.now();
      if (!force && now - lastClipboardSyncCheckAtRef.current < CLIPBOARD_SYNC_MIN_INTERVAL_MS) {
        return Promise.resolve();
      }
      lastClipboardSyncCheckAtRef.current = now;

      if (clipboardSyncPromiseRef.current) {
        return clipboardSyncPromiseRef.current;
      }

      const sync = (async () => {
        let text = "";
        try {
          text = await readClipboardText();
        } catch (err) {
          console.warn(`[vnc.clip] read local clipboard for ${reason} sync failed:`, err);
          return;
        }
        if (serverClipboardWriteInFlightRef.current > 0) {
          return;
        }

        // Avoid clearing the remote clipboard just because the local clipboard
        // is temporarily empty or unreadable.
        if (!text || text === lastSyncedLocalClipboardTextRef.current) {
          return;
        }
        // Non-ASCII text is sent even when the server lacks ExtendedClipboard:
        // the relay will fall back to UTF-8 legacy ClientCutText, which vino
        // and most modern servers accept despite RFC 6143 specifying Latin-1.
        lastSyncedLocalClipboardTextRef.current = text;
        console.info(
          `[vnc.clip] local→server ${reason} sync text_len=${text.length} ext_support=${extClipboardSupportedRef.current}`,
        );
        sendWs({ type: "ext_clipboard", text });
      })();

      const tracked = sync.finally(() => {
        if (clipboardSyncPromiseRef.current === tracked) {
          clipboardSyncPromiseRef.current = null;
        }
      });
      clipboardSyncPromiseRef.current = tracked;
      return clipboardSyncPromiseRef.current;
    },
    [allowClipboardSend, sendWs],
  );

  const scheduleReconnectRef = useRef<() => void>(() => {});

  // ── connect logic, callable for retry ─────────────────────────────
  const doConnect = useCallback(() => {
    const {
      host: h,
      port: p,
      username: user,
      password: pw,
      networkSettingsJson: ns,
      securityPolicy: policy,
      viewOnly: readOnly,
      clipboardPolicy: clipboardDirection,
    } = connectArgsRef.current;
    const generation = ++connectGenerationRef.current;
    destroyedRef.current = false;
    store.initConnection(tabId);

    let cancelled = false;
    suppressReconnectRef.current = false;
    pointerSchedulerRef.current?.reset();
    lastPointerSentRef.current = null;
    cursorShapeReceivedRef.current = false;
    setRemoteCursorCss("none");
    setSessionStats(null);
    if (reconnectStableTimerRef.current !== null) {
      window.clearTimeout(reconnectStableTimerRef.current);
      reconnectStableTimerRef.current = null;
    }
    const previousSessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    if (previousSessionId) {
      void vncDisconnect(previousSessionId).catch(() => {});
    }

    (async () => {
      try {
        const result = await vncConnect(
          h,
          p,
          user,
          pw,
          ns,
          policy,
          readOnly,
          clipboardDirection,
        );
        if (cancelled || destroyedRef.current || generation !== connectGenerationRef.current) {
          vncDisconnect(result.session_id).catch(() => {});
          return;
        }

        sessionIdRef.current = result.session_id;
        framebufferSizeRef.current = { width: result.width, height: result.height };
        framebufferGenerationRef.current = 0;
        store.setConnecting(tabId, result.session_id, result.ws_port);

        const ws = new WebSocket(`ws://127.0.0.1:${result.ws_port}/vnc`, `taomni-vnc.${result.ws_token}`);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          if (generation !== connectGenerationRef.current) {
            ws.close();
            return;
          }
          if (heartbeatTimerRef.current !== null) {
            window.clearInterval(heartbeatTimerRef.current);
          }
          // Ping every 15s; the backend tears the session down after 30s of silence.
          heartbeatTimerRef.current = window.setInterval(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(encodeWsPing());
            }
          }, 15000);
        };

        ws.onmessage = (event) => {
          if (destroyedRef.current || generation !== connectGenerationRef.current) return;
          if (event.data instanceof ArrayBuffer) {
            if (event.data.byteLength === 0) {
              if (dropFrameUntilBoundaryRef.current) {
                dropFrameUntilBoundaryRef.current = false;
                frameBufferRef.current = [];
                pendingFrameBytesRef.current = 0;
                ackPendingRef.current = false;
                requestFullRefresh();
                return;
              }
              // ACK only after the render loop has drained and painted the
              // logical frame. Hidden tabs retain one pending ACK and resume
              // with the newest bounded mailbox content when made visible.
              ackPendingRef.current = true;
              return;
            }
            if (dropFrameUntilBoundaryRef.current) return;
            const header = parseFrameHeader(event.data);
            const framebuffer = framebufferSizeRef.current;
            if (!header
              || header.x + header.w > framebuffer.width
              || header.y + header.h > framebuffer.height) {
              frameBufferRef.current = [];
              pendingFrameBytesRef.current = 0;
              dropFrameUntilBoundaryRef.current = true;
              return;
            }
            const rgba = new Uint8ClampedArray(
              event.data as ArrayBuffer,
              12,
            ) as Uint8ClampedArray<ArrayBuffer>;
            const queue = frameBufferRef.current;
            const nextBytes = pendingFrameBytesRef.current + rgba.byteLength;
            if (queue.length >= MAX_PENDING_RECTS || nextBytes > MAX_PENDING_FRAME_BYTES) {
              queue.length = 0;
              pendingFrameBytesRef.current = 0;
              dropFrameUntilBoundaryRef.current = true;
              return;
            }
            queue.push({ ...header, rgba });
            pendingFrameBytesRef.current += rgba.byteLength;
          } else {
            const msg = parseWsMessage(event.data as string);
            if (!msg) return;
            switch (msg.type) {
              case "connected":
                framebufferSizeRef.current = { width: msg.width, height: msg.height };
                framebufferGenerationRef.current = 0;
                store.setConnected(tabId, msg.width, msg.height, msg.name, msg.protocol, msg.security, msg.encrypted);
                reconnectStableTimerRef.current = window.setTimeout(() => {
                  if (generation === connectGenerationRef.current) {
                    reconnectAttemptRef.current = 0;
                  }
                  reconnectStableTimerRef.current = null;
                }, RECONNECT_STABLE_MS);
                break;
              case "desktop_size":
                if (msg.generation <= framebufferGenerationRef.current) break;
                framebufferGenerationRef.current = msg.generation;
                framebufferSizeRef.current = { width: msg.width, height: msg.height };
                frameBufferRef.current = [];
                pendingFrameBytesRef.current = 0;
                dropFrameUntilBoundaryRef.current = false;
                ackPendingRef.current = false;
                store.setDesktopSize(tabId, msg.width, msg.height);
                break;
              case "disconnected":
                suppressReconnectRef.current = !msg.retryable;
                store.setDisconnected(tabId, msg.reason);
                if (msg.retryable) scheduleReconnectRef.current();
                break;
              case "clipboard":
                if (!allowClipboardReceive) break;
                serverClipboardWriteInFlightRef.current += 1;
                writeClipboardText(msg.text)
                  .then(() => {
                    lastSyncedLocalClipboardTextRef.current = msg.text;
                  })
                  .catch(() => {})
                  .finally(() => {
                    serverClipboardWriteInFlightRef.current = Math.max(
                      0,
                      serverClipboardWriteInFlightRef.current - 1,
                    );
                  });
                break;
              case "ext_clipboard":
                if (!allowClipboardReceive) break;
                serverClipboardWriteInFlightRef.current += 1;
                writeMultiFormat({
                  text: msg.text ?? "",
                  html: msg.html,
                  rtf: msg.rtf,
                })
                  .then(() => {
                    if (msg.text !== undefined) {
                      lastSyncedLocalClipboardTextRef.current = msg.text;
                    }
                  })
                  .catch(() => {})
                  .finally(() => {
                    serverClipboardWriteInFlightRef.current = Math.max(
                      0,
                      serverClipboardWriteInFlightRef.current - 1,
                    );
                  });
                break;
              case "ext_clipboard_support":
                extClipboardSupportedRef.current = msg.available;
                console.info(
                  `[vnc.clip] server ExtendedClipboard support: ${msg.available}`,
                );
                break;
              case "cursor":
                cursorShapeReceivedRef.current = true;
                setRemoteCursorCss(vncCursorToCss(msg));
                break;
              case "pointer_pos":
                if (!cursorShapeReceivedRef.current) {
                  setRemoteCursorCss("default");
                }
                break;
              case "stats":
                setSessionStats({
                  requested_encoding: msg.requested_encoding,
                  last_encoding: msg.last_encoding,
                  pixel_format: msg.pixel_format,
                  wire_kbps: msg.wire_kbps,
                  line_kbps: msg.line_kbps,
                  updates_per_sec: msg.updates_per_sec,
                  frames_per_sec: msg.frames_per_sec,
                  update_ms: msg.update_ms,
                });
                break;
            }
          }
        };

        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          if (generation !== connectGenerationRef.current) return;
          if (heartbeatTimerRef.current !== null) {
            window.clearInterval(heartbeatTimerRef.current);
            heartbeatTimerRef.current = null;
          }
          if (!destroyedRef.current && !suppressReconnectRef.current) {
            store.setDisconnected(tabId, tr("vnc.closedConnection"));
            scheduleReconnectRef.current();
          }
        };

        ws.onerror = () => {
          if (!destroyedRef.current && generation === connectGenerationRef.current) {
            store.setDisconnected(tabId, tr("vnc.websocketError"));
          }
        };
      } catch (err) {
        if (!cancelled && !destroyedRef.current && generation === connectGenerationRef.current) {
          const structured = parseVncError(err);
          store.setDisconnected(tabId, structured.message);
          if (structured.retryable) scheduleReconnectRef.current();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [host, port, username, password, networkSettingsJson, securityPolicy, viewOnly, clipboardPolicy, allowClipboardReceive, tabId, store, requestFullRefresh]);

  scheduleReconnectRef.current = () => {
    if (destroyedRef.current || reconnectTimerRef.current !== null) return;
    const attempt = reconnectAttemptRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) return;
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!destroyedRef.current) doConnect();
    }, RECONNECT_DELAYS_MS[attempt]);
  };

  useEffect(() => {
    connectArgsRef.current = {
      host,
      port,
      username,
      password,
      networkSettingsJson,
      securityPolicy,
      viewOnly,
      clipboardPolicy,
    };
  }, [host, port, username, password, networkSettingsJson, securityPolicy, viewOnly, clipboardPolicy]);

  // ── Mount / unmount ───────────────────────────────────────────────
  useEffect(() => {
    let cancel: (() => void) | undefined;
    const connectTimer = window.setTimeout(() => {
      cancel = doConnect();
    }, 0);

    return () => {
      window.clearTimeout(connectTimer);
      cancel?.();
      destroyedRef.current = true;
      connectGenerationRef.current += 1;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      frameBufferRef.current = [];
      pendingFrameBytesRef.current = 0;
      dropFrameUntilBoundaryRef.current = false;
      framebufferSizeRef.current = { width: 0, height: 0 };
      framebufferGenerationRef.current = 0;
      pressedKeysymsRef.current.clear();
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (reconnectStableTimerRef.current !== null) {
        window.clearTimeout(reconnectStableTimerRef.current);
        reconnectStableTimerRef.current = null;
      }
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      if (pasteDelayTimerRef.current !== null) {
        window.clearTimeout(pasteDelayTimerRef.current);
        pasteDelayTimerRef.current = null;
      }
      ackPendingRef.current = false;
      pointerSchedulerRef.current?.dispose();
      pointerSchedulerRef.current = null;
      lastPointerSentRef.current = null;
      delayedPointerDownRef.current = null;
      pasteInFlightRef.current = null;
      extClipboardSupportedRef.current = false;
      cursorShapeReceivedRef.current = false;
      clipboardSyncPromiseRef.current = null;
      serverClipboardWriteInFlightRef.current = 0;
      lastClipboardSyncCheckAtRef.current = 0;
      lastSyncedLocalClipboardTextRef.current = null;
      setRemoteCursorCss("none");
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

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    if (!visible || conn?.status !== "connected" || !allowClipboardSend) return;
    void syncLocalClipboardToServer("connect", true);
    const timer = window.setInterval(() => {
      void syncLocalClipboardToServer("poll");
    }, CLIPBOARD_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [visible, conn?.status, allowClipboardSend, syncLocalClipboardToServer]);

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
      let rendered = false;
      let renderFailed = false;
      const hadPendingFrames = frames.length > 0;
      if (frames.length > 0) {
        const pending = frames.splice(0, frames.length);
        pendingFrameBytesRef.current = 0;

        if (canvas.width !== conn.width || canvas.height !== conn.height) {
          canvas.width = conn.width || 1;
          canvas.height = conn.height || 1;
        }

        for (const frame of pending) {
          if (frame.rgba.length !== frame.w * frame.h * 4) {
            renderFailed = true;
            continue;
          }
          const imgData = new ImageData(frame.rgba, frame.w || 1, frame.h || 1);
          try {
            ctx.putImageData(imgData, frame.x, frame.y);
            rendered = true;
          } catch {
            renderFailed = true;
          }
        }

      }

      if (ackPendingRef.current && (!hadPendingFrames || (rendered && !renderFailed))) {
        ackPendingRef.current = false;
        sendWsBinary(encodeWsAck());
      } else if (ackPendingRef.current && hadPendingFrames) {
        ackPendingRef.current = false;
        requestFullRefresh();
      }

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);

    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [visible, conn?.status, conn?.width, conn?.height, sendWsBinary, requestFullRefresh]);

  // ── Keyboard ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;

    const readLocalClipboard = async (): Promise<{
      text: string;
      html?: string;
      rtf?: string;
    } | null> => {
      try {
        const data = await readMultiFormat();
        if (!data.text && !data.html && !data.rtf) return null;
        return { text: data.text || "", html: data.html, rtf: data.rtf };
      } catch (err) {
        console.warn("[vnc.clip] read local clipboard failed:", err);
        return null;
      }
    };

    const sendExtClipboardToRelay = (data: {
      text: string;
      html?: string;
      rtf?: string;
    }) => {
      sendWs({
        type: "ext_clipboard",
        text: data.text || undefined,
        html: data.html,
        rtf: data.rtf,
      });
    };

    /**
     * When the user presses Ctrl+V on the canvas, send the clipboard content
     * via the relay (UTF-8 legacy ClientCutText for servers without
     * ExtendedClipboard, ExtendedClipboard for servers that support it).
     * instead and deliberately do not send the remote V shortcut.
     */
    const handlePasteShortcut = (e: KeyboardEvent) => {
      const pasteKeysym = keyEventToKeysym(e);
      if (pasteKeysym === 0 || pasteInFlightRef.current) return;

      pasteInFlightRef.current = {
        pasteKeysym,
        heldModifiers: pasteModifierKeysyms(e),
        deferredKeyUps: new Set<number>(),
      };

      void (async () => {
        const clipboard = await readLocalClipboard();
        const text = clipboard?.text ?? "";
        if (clipboard) {
          lastSyncedLocalClipboardTextRef.current = text;
          sendExtClipboardToRelay(clipboard);
        }
        console.info(
          `[vnc.clip] paste shortcut: text_len=${text.length} non_ascii=${hasNonAsciiText(text)} ext_support=${extClipboardSupportedRef.current} → clipboard+V`,
        );

        if (destroyedRef.current) {
          pasteInFlightRef.current = null;
          return;
        }
        if (pasteDelayTimerRef.current !== null) {
          window.clearTimeout(pasteDelayTimerRef.current);
        }

        // Wait briefly so the relay has time to ship the clipboard payload
        // ahead of the V keystroke (when we send one).
        pasteDelayTimerRef.current = window.setTimeout(() => {
          pasteDelayTimerRef.current = null;
          const pending = pasteInFlightRef.current;
          if (!pending || destroyedRef.current) {
            pasteInFlightRef.current = null;
            return;
          }

          // Release any held modifiers (Ctrl/Cmd/Shift) before injecting
          // characters — otherwise the remote app sees Ctrl+character
          // shortcuts instead of plain text.
          pending.heldModifiers.forEach((modKeysym) => {
            sendWsBinary(encodeWsKey(false, modKeysym));
          });

          // Re-press modifiers and send V so the remote app's paste shortcut
          // fires against the now-updated clipboard.
          pending.heldModifiers.forEach((modKeysym) => {
            sendWsBinary(encodeWsKey(true, modKeysym));
          });
          sendWsBinary(encodeWsKey(true, pasteKeysym));
          sendWsBinary(encodeWsKey(false, pasteKeysym));

          // The user's physical modifier keys are still held — defer their
          // key-ups until the user actually releases them so we don't
          // generate phantom up events.
          pending.deferredKeyUps.forEach((modKeysym) => {
            sendWsBinary(encodeWsKey(false, modKeysym));
          });
          pasteInFlightRef.current = null;
        }, PASTE_KEY_DELAY_MS);
      })();
    };

    const releaseAllInput = () => {
      pressedKeysymsRef.current.forEach((keysym) => {
        // Keys latched from the session menu stay down until toggled off.
        if (!latchedKeysymsRef.current.has(keysym)) sendWsBinary(encodeWsKey(false, keysym));
      });
      pressedKeysymsRef.current.clear();
      const last = lastPointerSentRef.current;
      if (last && last.buttons !== 0) {
        sendWsBinary(encodeWsPointer(last.x, last.y, 0));
        lastPointerSentRef.current = { ...last, buttons: 0 };
      }
    };

    const handleKey = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (isEditableTarget(e.target, activeEl))
        return;
      if (!isTerminalFocused(containerRef.current, activeEl))
        return;
      if (viewOnly) {
        if (e.key === "F8" && e.type === "keydown" && !e.repeat) {
          e.preventDefault();
          openSessionMenuRef.current();
        }
        return;
      }

      const pendingPaste = pasteInFlightRef.current;
      if (pendingPaste && e.type === "keyup") {
        const modifierKeysym = modifierKeysymFromKey(e.key);
        if (modifierKeysym && pendingPaste.heldModifiers.has(modifierKeysym)) {
          e.preventDefault();
          pendingPaste.deferredKeyUps.add(modifierKeysym);
          return;
        }
        const keysym = keyEventToKeysym(e);
        if (keysym === pendingPaste.pasteKeysym) {
          e.preventDefault();
          return;
        }
      }

      // F8 opens the session menu, as in RealVNC Viewer ("Send F8" in the
      // menu delivers the key itself).
      if (e.key === "F8" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        if (e.type === "keydown" && !e.repeat) {
          openSessionMenuRef.current();
        }
        return;
      }

      // Intercept Ctrl/Meta + V so the remote clipboard is updated before the
      // remote application receives the paste shortcut.
      if (isPasteShortcut(e)) {
        e.preventDefault();
        if (e.type === "keydown" && !e.repeat) {
          handlePasteShortcut(e);
        }
        return;
      }

      const keysym = keyEventToKeysym(e);
      if (keysym === 0) return;
      e.preventDefault();
      const down = e.type === "keydown";
      sendWsBinary(encodeWsKey(down, keysym));
      if (down) pressedKeysymsRef.current.add(keysym);
      else pressedKeysymsRef.current.delete(keysym);
    };

    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);

    // Keep the paste listener as a secondary path — useful when the OS
    // dispatches a paste event directly to the WebView.
    const handlePaste = (e: ClipboardEvent) => {
      if (!allowClipboardSend) return;
      const activeEl = document.activeElement;
      if (isEditableTarget(e.target, activeEl)) return;
      if (!isTerminalFocused(containerRef.current, activeEl)) return;

      const text = e.clipboardData?.getData("text/plain") ?? "";
      const html = e.clipboardData?.getData("text/html") || undefined;
      const rtf = e.clipboardData?.getData("text/rtf") || undefined;
      if (!text && !html && !rtf) return;
      if (text) {
        lastSyncedLocalClipboardTextRef.current = text;
      }
      sendWs({ type: "ext_clipboard", text, html, rtf });
    };
    window.addEventListener("paste", handlePaste);
    window.addEventListener("blur", releaseAllInput);
    document.addEventListener("visibilitychange", releaseAllInput);

    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKey);
      window.removeEventListener("paste", handlePaste);
      window.removeEventListener("blur", releaseAllInput);
      document.removeEventListener("visibilitychange", releaseAllInput);
    };
  }, [visible, conn?.status, viewOnly, allowClipboardSend, sendWs, sendWsBinary]);

  // ── Pointer ───────────────────────────────────────────────────────
  const getFbCoords = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const fbWidth = conn?.width ?? 0;
      const fbHeight = conn?.height ?? 0;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      // The canvas element is always sized to the scaled desktop (no
      // letterboxing inside it), so its box maps 1:1 onto the framebuffer.
      return mapClientToFramebuffer(clientX, clientY, rect, fbWidth, fbHeight, "one");
    },
    [conn?.width, conn?.height],
  );

  const sendPointerNow = useCallback(
    (pointer: VncPointerState) => {
      const last = lastPointerSentRef.current;
      if (
        last &&
        last.x === pointer.x &&
        last.y === pointer.y &&
        last.buttons === pointer.buttons
      ) {
        return;
      }
      if (sendWsBinary(encodeWsPointer(pointer.x, pointer.y, pointer.buttons))) {
        lastPointerSentRef.current = pointer;
      }
    },
    [sendWsBinary],
  );

  const pointerScheduler = useCallback(() => {
    if (!pointerSchedulerRef.current) {
      pointerSchedulerRef.current = new VncPointerScheduler({ send: sendPointerNow });
    }
    return pointerSchedulerRef.current;
  }, [sendPointerNow]);

  const handlePointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (viewOnly || conn?.status !== "connected") return;
      if (delayedPointerDownRef.current?.pointerId === e.pointerId) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const mapped = getFbCoords(e.clientX, e.clientY);
      if (!mapped) return;
      const allowOutside = ((e.type === "pointerup" || e.type === "pointercancel")
        && (lastPointerSentRef.current?.buttons ?? 0) !== 0)
        || (e.type === "pointermove" && e.buttons !== 0);
      if (!mapped.inside && !allowOutside) return;
      const { x, y } = mapped;
      const buttons = mouseButtonMask(e.nativeEvent);
      const pointer = { x, y, buttons };

      if (e.type === "pointermove") {
        // Chromium (WebView2) delivers moves earlier as pointerrawupdate;
        // once those arrive, the frame-aligned pointermove is a duplicate.
        if (rawPointerMovesRef.current) return;
        pointerScheduler().move(pointer);
        return;
      }

      pointerScheduler().sendNow(pointer);
    },
    [viewOnly, conn?.status, getFbCoords, pointerScheduler],
  );

  // VNC-PERF-005: pointermove is aligned to the next animation frame, which
  // costs Chromium-based WebViews one to two frames of pointer latency.
  // pointerrawupdate is dispatched as soon as input arrives; WebKit has no
  // such event and keeps the pointermove path.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewOnly || conn?.status !== "connected" || !("onpointerrawupdate" in window)) {
      rawPointerMovesRef.current = false;
      return;
    }
    const onRawUpdate = (event: Event) => {
      const e = event as PointerEvent;
      if (delayedPointerDownRef.current?.pointerId === e.pointerId) return;
      const mapped = getFbCoords(e.clientX, e.clientY);
      if (!mapped) return;
      if (!mapped.inside && e.buttons === 0) return;
      rawPointerMovesRef.current = true;
      pointerScheduler().move({ x: mapped.x, y: mapped.y, buttons: mouseButtonMask(e) });
    };
    canvas.addEventListener("pointerrawupdate", onRawUpdate);
    return () => {
      canvas.removeEventListener("pointerrawupdate", onRawUpdate);
      rawPointerMovesRef.current = false;
    };
  }, [viewOnly, conn?.status, getFbCoords, pointerScheduler]);

  // Push a fresh local clipboard when the pointer enters the desktop, so a
  // paste click right after copying elsewhere sees the new content.
  const handlePointerEnter = useCallback(() => {
    if (viewOnly || conn?.status !== "connected") return;
    void syncLocalClipboardToServer("enter", true);
  }, [viewOnly, conn?.status, syncLocalClipboardToServer]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const mapped = getFbCoords(e.clientX, e.clientY);
      if (!mapped?.inside) return;
      e.currentTarget.focus({ preventScroll: true });
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture can fail if the event was already cancelled.
      }
      // Right clicks go out immediately like RealVNC Viewer. The clipboard is
      // synced on pointer enter / focus instead of delaying the click; only a
      // middle click (X11 paste) waits briefly for a sync that is in flight.
      const pendingClipboardSync = clipboardSyncPromiseRef.current;
      if (!viewOnly && conn?.status === "connected" && e.button === 1 && pendingClipboardSync) {
        e.preventDefault();
        const { x, y } = mapped;
        const delayed: DelayedPointerDown = {
          pointerId: e.pointerId,
          down: { x, y, buttons: mouseButtonMask(e.nativeEvent) },
          up: null,
        };
        delayedPointerDownRef.current = delayed;
        pointerSchedulerRef.current?.cancelPending();
        void (async () => {
          await Promise.race([
            pendingClipboardSync,
            new Promise((resolve) => window.setTimeout(resolve, MIDDLE_CLICK_CLIPBOARD_WAIT_MS)),
          ]);
          if (destroyedRef.current || delayedPointerDownRef.current !== delayed) return;
          sendPointerNow(delayed.down);
          if (delayed.up) {
            sendPointerNow(delayed.up);
          }
          delayedPointerDownRef.current = null;
        })();
        return;
      }
      handlePointer(e);
    },
    [viewOnly, conn?.status, getFbCoords, handlePointer, sendPointerNow, syncLocalClipboardToServer],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const delayed = delayedPointerDownRef.current;
      if (delayed?.pointerId === e.pointerId) {
        e.preventDefault();
        const mapped = getFbCoords(e.clientX, e.clientY);
        if (mapped) {
          delayed.up = { x: mapped.x, y: mapped.y, buttons: mouseButtonMask(e.nativeEvent) };
        }
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // The pointer may already have been released by the platform.
        }
        return;
      }
      handlePointer(e);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // The pointer may already have been released by the platform.
      }
    },
    [getFbCoords, handlePointer],
  );

  // Wheel: a native non-passive listener so preventDefault stops the page (or
  // the scrolling container) from scrolling. Deltas accumulate into detents;
  // each detent is an immediate press+release that keeps held buttons.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewOnly || conn?.status !== "connected") return;
    const accumulator = wheelAccumulatorRef.current;
    accumulator.reset();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const mapped = getFbCoords(e.clientX, e.clientY);
      if (!mapped?.inside) return;
      const steps = accumulator.push(
        e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX,
        e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY,
        e.deltaMode,
      );
      if (steps.length === 0) return;
      pointerSchedulerRef.current?.cancelPending();
      const held = mouseButtonMask(e);
      for (const step of steps) {
        sendWsBinary(encodeWsPointer(mapped.x, mapped.y, held | step));
        sendWsBinary(encodeWsPointer(mapped.x, mapped.y, held));
      }
      lastPointerSentRef.current = { x: mapped.x, y: mapped.y, buttons: held };
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [viewOnly, conn?.status, getFbCoords, sendWsBinary]);

  // ── Viewport tracking for scaling ─────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      setViewportSize({ width: container.clientWidth, height: container.clientHeight });
      setDevicePixelRatio(window.devicePixelRatio || 1);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(container);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const displaySize = computeVncDisplaySize(
    scaling,
    conn?.width ?? 0,
    conn?.height ?? 0,
    viewportSize.width,
    viewportSize.height,
    devicePixelRatio,
    preserveAspect,
  );

  // ── Canvas CSS size for scaling ───────────────────────────────────
  const canvasStyle: React.CSSProperties = {
    width: displaySize.width,
    height: displaySize.height,
    flex: "none",
    // Center when smaller than the viewport; scroll from the top-left edge
    // when larger (auto margins collapse to 0 in an overflowing flex box).
    margin: "auto",
    cursor: conn?.status === "connected" ? remoteCursorCss : "default",
    maxWidth: "none",
    maxHeight: "none",
  };

  // ── Render ───────────────────────────────────────────────────────
  const showCanvas = conn?.status === "connected";
  const showConnecting = conn?.status === "connecting";
  const showError =
    conn?.status === "disconnected" || conn?.status === "error";

  // Publish this VNC canvas as the active capture source while connected and
  // visible, so the screenshot actions (tab-strip `⋯` menu / detached capture
  // button) target the framebuffer.
  useEffect(() => {
    if (!visible || !showCanvas) return;
    const source: CaptureSource = {
      filenamePrefix: `vnc-${host}`,
      getVisible: async () => {
        if (!canvasRef.current) throw new Error(t("vnc.notReady"));
        return await captureCanvasPng(canvasRef.current);
      },
      getFull: async () => {
        if (!canvasRef.current) throw new Error(t("vnc.notReady"));
        return await captureCanvasPng(canvasRef.current);
      },
      getScrollFrame: async () => canvasRef.current ?? null,
      getGifFrame: async () => canvasRef.current ?? null,
      onStatus: (msg) => useAppStore.getState().setStatusMessage(msg),
    };
    useCaptureStore.getState().setSource(source);
    return () => useCaptureStore.getState().clearSource(source);
  }, [visible, showCanvas, host, t]);

  return (
    <div
      ref={containerRef}
      className="vnc-container"
      data-testid="vnc-panel"
      data-vnc-scaling={String(scaling)}
      style={{
        width: "100%",
        height: "100%",
        overflow: displaySize.scrolls ? "auto" : "hidden",
        display: "flex",
        backgroundColor: "#1a1a2e",
        position: "relative",
      }}
    >
      {/* Tab-action toolbar. Always rendered so a dropped session can still be
          restored; the scale control needs the live canvas, so it's gated on
          the connection state. Screenshot actions live in the tab-strip `⋯`
          menu (main window) or the detached capture button. */}
      <TabActions active={visible}>
        {showCanvas && (
          <>
            {!viewOnly && (
              <button
                data-testid="vnc-send-cad"
                onClick={sendCtrlAltDel}
                style={FT_ICON_BUTTON_STYLE}
                title={t("vnc.sendCtrlAltDel")}
                aria-label={t("vnc.sendCtrlAltDel")}
              >
                <ShieldAlert size={14} />
              </button>
            )}
            <button
              data-testid="vnc-scale-toggle"
              onClick={() => setScaling((current) => (current === "auto" ? 100 : "auto"))}
              style={FT_ICON_BUTTON_STYLE}
              title={scaling === "auto" ? t("vnc.scaleTo100") : t("vnc.scaleAutomatically")}
              aria-label={scaling === "auto" ? t("vnc.scaleTo100") : t("vnc.scaleAutomatically")}
              aria-pressed={scaling !== "auto"}
            >
              {scaling === "auto" ? <Maximize size={14} /> : <Minimize size={14} />}
            </button>
            {!detachedWindowControls && canFullScreen && (
              <button
                data-testid="vnc-fullscreen"
                onClick={toggleFullScreen}
                style={FT_ICON_BUTTON_STYLE}
                title={fullScreen ? t("vnc.exitFullScreen") : t("vnc.fullScreen")}
                aria-label={fullScreen ? t("vnc.exitFullScreen") : t("vnc.fullScreen")}
              >
                {fullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            )}
            <button
              data-testid="vnc-session-menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                openSessionMenu(rect.left, rect.bottom + 4);
              }}
              style={FT_ICON_BUTTON_STYLE}
              title={t("vnc.sessionMenu")}
              aria-label={t("vnc.sessionMenu")}
              aria-haspopup="menu"
            >
              <MenuIcon size={14} />
            </button>
          </>
        )}
          {onDetach && (
            <>
              <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
              <button
                data-testid="vnc-detach"
                onClick={onDetach}
                title={t("rdp.detach")}
                aria-label={t("rdp.detach")}
                style={FT_ICON_BUTTON_STYLE}
              >
                <ExternalLink size={14} />
              </button>
            </>
          )}
          {detachedWindowControls && (
            <>
              <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
              <CaptureMenuButton />
              <button
                data-testid="detached-reattach"
                onClick={detachedWindowControls.onReattach}
                title={t("rdp.reattach")}
                aria-label={t("rdp.reattach")}
                style={FT_BUTTON_STYLE}
              >
                <ExternalLink size={14} />
                <span>{t("rdp.reattach")}</span>
              </button>
              <button
                data-testid="detached-os-fullscreen"
                onClick={detachedWindowControls.onToggleOsFullscreen}
                title={t("rdp.osFullscreen")}
                aria-label={t("rdp.osFullscreen")}
                style={FT_ICON_BUTTON_STYLE}
              >
                {detachedWindowControls.osFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </>
          )}
        </TabActions>

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
            <p>{t("vnc.connectingHost", { host, port })}</p>
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
            <p>{conn?.error ? t("vnc.disconnectedReason", { reason: conn.error }) : t("vnc.disconnected")}</p>
          </div>
          <button
            data-testid="vnc-reconnect"
            onClick={() => {
              if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
              }
              // Manual reconnect resets the bounded backoff budget.
              reconnectAttemptRef.current = 0;
              if (reconnectTimerRef.current !== null) {
                window.clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
              }
              if (reconnectStableTimerRef.current !== null) {
                window.clearTimeout(reconnectStableTimerRef.current);
                reconnectStableTimerRef.current = null;
              }
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
            {t("vnc.reconnect")}
          </button>
        </div>
      )}

      <canvas
        ref={canvasRef}
        data-testid="vnc-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointer}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerEnter={handlePointerEnter}
        onContextMenu={(e) => e.preventDefault()}
        onAuxClick={(e) => e.preventDefault()}
        style={{
          display: showCanvas ? "block" : "none",
          ...canvasStyle,
          touchAction: "none",
          userSelect: "none",
        }}
        tabIndex={0}
      />
      {sessionMenu.render}
      {infoOpen && (
        <VncSessionInfoDialog
          info={{
            desktopName: conn?.name ?? "",
            device: `${host}:${port}`,
            width: conn?.width ?? 0,
            height: conn?.height ?? 0,
            protocol: conn?.protocol ?? "",
            security: conn?.security ?? "",
            encrypted: conn?.encrypted ?? false,
            proxied: networkSettingsUsesTunnel(networkSettingsJson),
            stats: sessionStats,
          }}
          onClose={() => setInfoOpen(false)}
        />
      )}
    </div>
  );
}

function networkSettingsUsesTunnel(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const settings = JSON.parse(raw) as { proxy_kind?: string; jump_host?: string; jump_session_id?: string };
    const proxy = settings.proxy_kind && settings.proxy_kind !== "none";
    return Boolean(proxy || settings.jump_host || settings.jump_session_id);
  } catch {
    return false;
  }
}
