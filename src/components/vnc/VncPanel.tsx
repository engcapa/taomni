import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import {
  vncConnect,
  vncCancelConnect,
  vncDisconnect,
  encodeWsAck,
  encodeWsQuality,
  codePointToKeysym,
  encodeWsKey,
  encodeWsPing,
  encodeWsPointer,
  encodeWsRefresh,
  parseWsMessage,
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
import type {
  VncClipboardPolicy,
  VncNativePointerTarget,
  VncScaling,
  VncSecurityPolicy,
  VncSessionStats,
  WsOutgoing,
} from "../../lib/vnc";
import { VncFramePainter, type VncPaintStats } from "../../lib/vncFramePainter";
import {
  DEFAULT_VNC_VIEWER_OPTIONS,
  pictureQualityWire,
  type VncPictureQuality,
  type VncViewerOptions,
} from "../../lib/vncOptions";
import { buildVncSessionMenuItems } from "./vncSessionMenu";
import { VncSessionInfoDialog } from "./VncSessionInfoDialog";
import { VncConnectionOverlay, type VncOverlayView } from "./VncConnectionOverlay";
import { VncPropertiesDialog, type VncSessionProperties } from "./VncPropertiesDialog";
import { VncFullScreenToolbar } from "./VncFullScreenToolbar";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAppPlatform, isTauriRuntime } from "../../lib/runtime";
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
  securityPolicy?: VncSecurityPolicy;
  viewOnly?: boolean;
  clipboardPolicy?: VncClipboardPolicy;
  /** Initial viewer scaling ("auto", "fit", "fit-width", "fit-height" or a percentage). */
  initialScaling?: VncScaling | string;
  /** Saved per-session viewer options (VNC-CONN-001); defaults match RealVNC. */
  viewerOptions?: VncViewerOptions;
  /** Persist changed viewer / reconnect-time settings back to the session. */
  onSessionPropertiesChange?: (properties: VncSessionProperties) => void;
  /** "Remember password" from the in-session authentication form. */
  onCredentialsChange?: (credentials: { username: string; password: string }) => void;
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
const CLIPBOARD_SYNC_MIN_INTERVAL_MS = 250;
/** RealVNC `ServerClipboardGraceTime`: ignore local changes right after a server paste. */
const SERVER_CLIPBOARD_GRACE_MS = 1000;
/** "Send clipboard as keystrokes" limit and pacing. */
const CLIPBOARD_KEYSTROKE_LIMIT = 4096;
const CLIPBOARD_KEYSTROKE_BATCH = 64;
/** Automatic reconnect backoff (RealVNC `AutoReconnect`), last step repeats. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000] as const;
const RECONNECT_STABLE_MS = 30_000;
/** Windows AltGr arrives as a synthetic ControlLeft right before AltRight. */
const ALTGR_PAIR_WINDOW_MS = 10;
const ALTGR_FLUSH_MS = 100;
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

function newAttemptId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `vnc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Keysyms for keys the Windows keyboard hook passes through (VNC-INPUT-003). */
/** Window state screen-level full screen changed, restored on exit. */
type FullScreenRestore = { maximized: boolean; osFullscreen: boolean; resizable: boolean };

async function restoreWindowAfterFullScreen(
  w: ReturnType<typeof getCurrentWindow>,
  restore: FullScreenRestore | null,
): Promise<void> {
  if (!restore?.osFullscreen) await w.setFullscreen(false);
  if (restore?.resizable) await w.setResizable(true);
  if (restore?.maximized) await w.maximize();
}

const SPECIAL_KEY_KEYSYMS: Record<string, number> = {
  MetaLeft: 0xffeb,
  MetaRight: 0xffec,
  Tab: 0xff09,
  Escape: 0xff1b,
  PrintScreen: 0xff61,
};

let bellContext: AudioContext | null = null;
/** RealVNC `AcceptBell`: a short beep for the RFB Bell message. */
function playBell(): void {
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    bellContext ??= new Ctor();
    const oscillator = bellContext.createOscillator();
    const gain = bellContext.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.05;
    oscillator.connect(gain).connect(bellContext.destination);
    oscillator.start();
    oscillator.stop(bellContext.currentTime + 0.1);
  } catch {
    // Audio is best effort.
  }
}

export default function VncPanel({
  tabId,
  host,
  port,
  username,
  password,
  networkSettingsJson,
  securityPolicy,
  viewOnly: viewOnlyProp = false,
  clipboardPolicy: clipboardPolicyProp = "bidirectional",
  initialScaling = "auto",
  viewerOptions: viewerOptionsProp,
  onSessionPropertiesChange,
  onCredentialsChange,
  visible,
  onDetach,
  detachedWindowControls,
}: VncPanelProps) {
  const t = useT();
  // View-only and the clipboard direction are enforced by the backend per
  // connection, so an in-session change only takes effect on reconnect.
  const [sessionSettings, setSessionSettings] = useState({
    viewOnly: viewOnlyProp,
    clipboardPolicy: clipboardPolicyProp,
  });
  const pendingSessionSettingsRef = useRef<typeof sessionSettings | null>(null);
  const { viewOnly, clipboardPolicy } = sessionSettings;
  const [viewer, setViewer] = useState<VncViewerOptions>(() => viewerOptionsProp ?? DEFAULT_VNC_VIEWER_OPTIONS);
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const framebufferSizeRef = useRef({ width: 0, height: 0 });
  const framebufferGenerationRef = useRef(0);
  const pressedKeysymsRef = useRef(new Set<number>());
  // Physical key (KeyboardEvent.code) -> keysym sent on its key-down.
  const keyCodeKeysymsRef = useRef(new Map<string, number>());
  const painterRef = useRef<VncFramePainter | null>(null);
  const destroyedRef = useRef(false);
  const suppressReconnectRef = useRef(false);
  const connectArgsRef = useRef({
    host,
    port,
    username,
    password,
    networkSettingsJson,
    securityPolicy,
    viewOnly: viewOnlyProp,
    clipboardPolicy: clipboardPolicyProp,
  });
  // Credentials typed into the in-session authentication form.
  const credentialOverrideRef = useRef<{ username: string; password: string } | null>(null);
  // The user accepted the unencrypted-connection warning for the next attempt.
  const unencryptedConfirmedRef = useRef(false);
  // DEC-VNC-21: the attempt that stopped to ask for credentials had already
  // passed the unencrypted warning, so the retry with them does not ask again.
  const credentialsRetryConfirmedRef = useRef(false);
  const attemptIdRef = useRef<string | null>(null);
  const [lifecycle, setLifecycle] = useState<
    | { kind: "unencrypted" }
    | { kind: "auth"; error: string | null }
    | { kind: "reconnecting"; attempt: number; at: number; reason: string | null }
    | null
  >(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const heartbeatTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectStableTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectGenerationRef = useRef(0);
  const visibleRef = useRef(visible);
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
  const [scaling, setScaling] = useState<VncScaling>(() =>
    normalizeVncScaling(viewerOptionsProp?.scaling ?? initialScaling));
  const [preserveAspect, setPreserveAspect] = useState(() => viewerOptionsProp?.preserveAspect ?? true);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const serverClipboardGraceUntilRef = useRef(0);
  const altGrArmedRef = useRef<{ timeStamp: number; timer: number } | null>(null);
  const altGrSuppressedCtrlRef = useRef(false);
  // Sends a Ctrl press still held back by the AltGr check (set by the key handler).
  const flushAltGrRef = useRef<() => void>(() => {});
  const canvasFocusedRef = useRef(false);
  const [canvasFocused, setCanvasFocused] = useState(false);
  const [screenFullScreen, setScreenFullScreen] = useState(false);
  const fullScreenRestoreRef = useRef<FullScreenRestore | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [devicePixelRatio, setDevicePixelRatio] = useState(() => window.devicePixelRatio || 1);
  const [ctrlLatched, setCtrlLatched] = useState(false);
  const [altLatched, setAltLatched] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [sessionStats, setSessionStats] = useState<VncSessionStats | null>(null);
  const [paintStats, setPaintStats] = useState<VncPaintStats | null>(null);
  const wheelAccumulatorRef = useRef(new VncWheelAccumulator());
  // True once the WebView delivers pointerrawupdate for this canvas.
  const rawPointerMovesRef = useRef(false);
  // VNC-PERF-005: the relay offers native cursor sampling (Windows); while it
  // is on, the relay sends plain moves and this panel sends buttons only.
  const nativePointerAvailableRef = useRef(false);
  const nativePointerOnRef = useRef(false);
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

  // VNC-PERF-003: paint on demand when a relay frame boundary arrives instead
  // of keeping a resident requestAnimationFrame loop.
  const getPainter = useCallback((): VncFramePainter => {
    if (!painterRef.current) {
      painterRef.current = new VncFramePainter({
        getContext: () => canvasRef.current?.getContext("2d") ?? null,
        framebufferSize: () => framebufferSizeRef.current,
        isVisible: () => visibleRef.current && !destroyedRef.current,
        sendAck: () => {
          sendWsBinary(encodeWsAck());
        },
        requestFullRefresh,
      });
    }
    return painterRef.current;
  }, [requestFullRefresh, sendWsBinary]);

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
    || isTauriRuntime()
    || (typeof document !== "undefined" && typeof document.documentElement?.requestFullscreen === "function");

  // VNC-VIEW-002 / DEC-VNC-18: screen-level full screen is the OS window in
  // full screen plus this panel covering the whole WebView. The Fullscreen
  // API is not used, so Esc and every other key still reach the remote.
  const setWindowFullScreen = useCallback(async (next: boolean) => {
    if (!isTauriRuntime()) {
      setScreenFullScreen(next);
      return;
    }
    try {
      const w = getCurrentWindow();
      if (next) {
        const restore = {
          maximized: await w.isMaximized(),
          osFullscreen: await w.isFullscreen(),
          resizable: await w.isResizable(),
        };
        fullScreenRestoreRef.current = restore;
        // A maximized borderless window keeps a work-area-sized surface on
        // Windows unless it leaves the maximized state first.
        if (restore.maximized) await w.unmaximize();
        // Tauri resizes undecorated windows through a child window over the
        // window edges; in full screen it would take the pointer at the top
        // edge (the toolbar hot zone). A non-resizable window has none.
        if (restore.resizable) await w.setResizable(false);
        if (!restore.osFullscreen) await w.setFullscreen(true);
      } else {
        const restore = fullScreenRestoreRef.current;
        fullScreenRestoreRef.current = null;
        await restoreWindowAfterFullScreen(w, restore);
      }
    } catch {
      // Window API unavailable: the in-WebView cover still applies.
    }
    setScreenFullScreen(next);
  }, []);

  const fullScreen = detachedWindowControls ? detachedWindowControls.osFullscreen : screenFullScreen;

  const toggleFullScreen = useCallback(() => {
    if (detachedWindowControls) {
      detachedWindowControls.onToggleOsFullscreen();
      return;
    }
    void setWindowFullScreen(!screenFullScreen);
  }, [detachedWindowControls, screenFullScreen, setWindowFullScreen]);

  // Leaving the tab or closing it restores the window.
  useEffect(() => {
    if (!screenFullScreen || visible) return;
    void setWindowFullScreen(false);
  }, [screenFullScreen, visible, setWindowFullScreen]);
  useEffect(() => () => {
    if (fullScreenRestoreRef.current && isTauriRuntime()) {
      const restore = fullScreenRestoreRef.current;
      void restoreWindowAfterFullScreen(getCurrentWindow(), restore).catch(() => {});
    }
  }, []);

  const updateViewer = useCallback((patch: Partial<VncViewerOptions>) => {
    const next = { ...viewerRef.current, ...patch };
    viewerRef.current = next;
    setViewer(next);
    onSessionPropertiesChange?.({
      viewer: next,
      viewOnly: pendingSessionSettingsRef.current?.viewOnly ?? sessionSettings.viewOnly,
      clipboardPolicy: pendingSessionSettingsRef.current?.clipboardPolicy ?? sessionSettings.clipboardPolicy,
    });
  }, [onSessionPropertiesChange, sessionSettings]);

  // VNC-PERF-004: picture quality applies at once through the relay.
  const setPictureQuality = useCallback((quality: VncPictureQuality) => {
    updateViewer({ pictureQuality: quality });
    sendWsBinary(encodeWsQuality(pictureQualityWire(quality)));
  }, [sendWsBinary, updateViewer]);

  const changeScaling = useCallback((next: VncScaling) => {
    setScaling(next);
    updateViewer({ scaling: next });
  }, [updateViewer]);

  const changePreserveAspect = useCallback((next: boolean) => {
    setPreserveAspect(next);
    updateViewer({ preserveAspect: next });
  }, [updateViewer]);

  const closeConnection = useCallback(() => {
    suppressReconnectRef.current = true;
    setLifecycle(null);
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
        fullScreen,
        canFullScreen,
        viewOnly,
        ctrlLatched,
        altLatched,
        scaling,
        preserveAspect,
        pictureQuality: viewer.pictureQuality,
        clipboardToServer: allowClipboardSend,
      },
      {
        toggleFullScreen,
        sendF8: () => sendKeyCombo([VNC_KEYSYM.f8]),
        sendCtrlAltDel,
        toggleCtrl: () => setKeyLatched(VNC_KEYSYM.controlL, !latchedKeysymsRef.current.has(VNC_KEYSYM.controlL)),
        toggleAlt: () => setKeyLatched(VNC_KEYSYM.altL, !latchedKeysymsRef.current.has(VNC_KEYSYM.altL)),
        setScaling: changeScaling,
        togglePreserveAspect: () => changePreserveAspect(!preserveAspect),
        refreshScreen: requestFullRefresh,
        showSessionInfo: () => setInfoOpen(true),
        showProperties: () => setPropertiesOpen(true),
        setPictureQuality,
        sendClipboardAsKeys: () => sendClipboardAsKeysRef.current(),
        closeConnection,
      },
      tr,
    ));
  }, [
    allowClipboardSend, altLatched, canFullScreen, changePreserveAspect, changeScaling, closeConnection,
    ctrlLatched, fullScreen, preserveAspect, requestFullRefresh, scaling, sendCtrlAltDel, sendKeyCombo,
    sessionMenu, setKeyLatched, setPictureQuality, toggleFullScreen, viewOnly, viewer.pictureQuality,
  ]);
  const sendClipboardAsKeysRef = useRef<() => void>(() => {});
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
      // Changes right after writing the server's clipboard are that write
      // echoing back (RealVNC ServerClipboardGraceTime).
      if (now < serverClipboardGraceUntilRef.current) {
        return Promise.resolve();
      }
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

  // "Send clipboard as keystrokes": types the local clipboard text for
  // targets without clipboard support (login screens, consoles).
  sendClipboardAsKeysRef.current = () => {
    if (viewOnly || !allowClipboardSend) return;
    void (async () => {
      let text = "";
      try {
        text = await readClipboardText();
      } catch {
        return;
      }
      const keysyms: number[] = [];
      for (const ch of text) {
        if (keysyms.length >= CLIPBOARD_KEYSTROKE_LIMIT) break;
        if (ch === "\r") continue;
        if (ch === "\n") keysyms.push(0xff0d);
        else if (ch === "\t") keysyms.push(0xff09);
        else {
          const keysym = codePointToKeysym(ch.codePointAt(0) ?? 0);
          if (keysym) keysyms.push(keysym);
        }
      }
      for (let index = 0; index < keysyms.length; index += CLIPBOARD_KEYSTROKE_BATCH) {
        if (destroyedRef.current || wsRef.current?.readyState !== WebSocket.OPEN) return;
        keysyms.slice(index, index + CLIPBOARD_KEYSTROKE_BATCH).forEach((keysym) => {
          sendWsBinary(encodeWsKey(true, keysym));
          sendWsBinary(encodeWsKey(false, keysym));
        });
        await new Promise((resolve) => window.setTimeout(resolve, 16));
      }
    })();
  };

  const scheduleReconnectRef = useRef<(reason?: string | null) => void>(() => {});

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
    setLifecycle(null);
    // Reconnect-time settings changed in Properties apply now.
    const pendingSettings = pendingSessionSettingsRef.current;
    pendingSessionSettingsRef.current = null;
    const effectiveReadOnly = pendingSettings?.viewOnly ?? readOnly;
    const effectiveClipboard = pendingSettings?.clipboardPolicy ?? clipboardDirection;
    if (pendingSettings) {
      connectArgsRef.current = { ...connectArgsRef.current, ...pendingSettings };
      setSessionSettings(pendingSettings);
    }
    const override = credentialOverrideRef.current;
    const viewerNow = viewerRef.current;
    // Confirmation of the unencrypted warning covers one attempt, like RealVNC.
    const allowUnencrypted = !viewerNow.warnUnencrypted || unencryptedConfirmedRef.current;
    unencryptedConfirmedRef.current = false;
    const attemptId = newAttemptId();
    attemptIdRef.current = attemptId;

    let cancelled = false;
    suppressReconnectRef.current = false;
    painterRef.current?.reset();
    pointerSchedulerRef.current?.reset();
    lastPointerSentRef.current = null;
    cursorShapeReceivedRef.current = false;
    setRemoteCursorCss("none");
    setSessionStats(null);
    setPaintStats(null);
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
          override ? override.username || user : user,
          override ? override.password : pw,
          ns,
          policy,
          effectiveReadOnly,
          effectiveClipboard,
          {
            pictureQuality: viewerNow.pictureQuality,
            shared: viewerNow.shared,
            allowUnencrypted,
            attemptId,
          },
        );
        if (attemptIdRef.current === attemptId) attemptIdRef.current = null;
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
            // Rectangles queue until the empty boundary message; the painter
            // paints the whole frame in one animation frame and ACKs it. A
            // hidden tab keeps the frame (and its ACK) until it is shown.
            getPainter().receive(event.data);
          } else {
            const msg = parseWsMessage(event.data as string);
            if (!msg) return;
            switch (msg.type) {
              case "connected":
                framebufferSizeRef.current = { width: msg.width, height: msg.height };
                framebufferGenerationRef.current = 0;
                nativePointerAvailableRef.current = msg.native_pointer === true;
                nativePointerOnRef.current = false;
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
                getPainter().reset();
                store.setDesktopSize(tabId, msg.width, msg.height);
                break;
              case "disconnected":
                suppressReconnectRef.current = !msg.retryable;
                store.setDisconnected(tabId, msg.reason);
                if (msg.retryable) scheduleReconnectRef.current(msg.reason);
                break;
              case "bell":
                if (viewerRef.current.acceptBell) playBell();
                break;
              case "clipboard":
                if (!allowClipboardReceive) break;
                serverClipboardGraceUntilRef.current = Date.now() + SERVER_CLIPBOARD_GRACE_MS;
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
                serverClipboardGraceUntilRef.current = Date.now() + SERVER_CLIPBOARD_GRACE_MS;
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
                setPaintStats(getPainter().takeStats());
                setSessionStats({
                  requested_encoding: msg.requested_encoding,
                  last_encoding: msg.last_encoding,
                  pixel_format: msg.pixel_format,
                  wire_kbps: msg.wire_kbps,
                  line_kbps: msg.line_kbps,
                  updates_per_sec: msg.updates_per_sec,
                  frames_per_sec: msg.frames_per_sec,
                  update_ms: msg.update_ms,
                  quality: msg.quality,
                  quality_level: msg.quality_level,
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
            scheduleReconnectRef.current(tr("vnc.closedConnection"));
          }
        };

        ws.onerror = () => {
          if (!destroyedRef.current && generation === connectGenerationRef.current) {
            store.setDisconnected(tabId, tr("vnc.websocketError"));
          }
        };
      } catch (err) {
        if (attemptIdRef.current === attemptId) attemptIdRef.current = null;
        if (!cancelled && !destroyedRef.current && generation === connectGenerationRef.current) {
          const structured = parseVncError(err);
          store.setDisconnected(tabId, structured.message);
          if (structured.code === "unencrypted-confirmation-required") {
            // RealVNC asks before any credential is exchanged.
            setLifecycle({ kind: "unencrypted" });
          } else if (structured.code === "credentials-required") {
            // The server wants a password the session does not have; nothing
            // was sent, so ask without an error (RealVNC asks only now).
            credentialsRetryConfirmedRef.current = allowUnencrypted;
            setLifecycle({ kind: "auth", error: null });
          } else if (structured.code === "authentication-failed") {
            credentialOverrideRef.current = null;
            credentialsRetryConfirmedRef.current = false;
            setLifecycle({ kind: "auth", error: structured.message });
          } else if (structured.code === "connection-stopped") {
            // The user pressed Stop; stay disconnected.
          } else if (structured.retryable) {
            scheduleReconnectRef.current(structured.message);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [host, port, username, password, networkSettingsJson, securityPolicy, viewOnly, clipboardPolicy, allowClipboardReceive, tabId, store, getPainter]);

  // RealVNC AutoReconnect: keep retrying an unexpectedly lost connection with
  // backoff until it succeeds or the user stops it.
  scheduleReconnectRef.current = (reason?: string | null) => {
    if (destroyedRef.current || reconnectTimerRef.current !== null) return;
    if (!viewerRef.current.autoReconnect) return;
    const attempt = reconnectAttemptRef.current;
    reconnectAttemptRef.current += 1;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    setLifecycle({ kind: "reconnecting", attempt: attempt + 1, at: Date.now() + delay, reason: reason ?? null });
    setClockNow(Date.now());
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!destroyedRef.current) doConnect();
    }, delay);
  };

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // Stop: abandon the attempt in flight (the backend closes its socket) or
  // the pending automatic reconnect.
  const stopConnecting = useCallback(() => {
    clearReconnectTimer();
    suppressReconnectRef.current = true;
    const attemptId = attemptIdRef.current;
    attemptIdRef.current = null;
    if (attemptId) void vncCancelConnect(attemptId).catch(() => false);
    connectGenerationRef.current += 1;
    setLifecycle(null);
    store.setDisconnected(tabId, tr("vnc.connectionStopped"));
  }, [clearReconnectTimer, store, tabId]);

  const reconnectNow = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    // Manual reconnect resets the backoff.
    reconnectAttemptRef.current = 0;
    clearReconnectTimer();
    if (reconnectStableTimerRef.current !== null) {
      window.clearTimeout(reconnectStableTimerRef.current);
      reconnectStableTimerRef.current = null;
    }
    doConnect();
  }, [clearReconnectTimer, doConnect]);

  useEffect(() => {
    if (lifecycle?.kind !== "reconnecting") return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [lifecycle?.kind]);

  // Session settings passed down later (after Properties persisted them)
  // apply on the next connection.
  useEffect(() => {
    if (viewOnlyProp === sessionSettings.viewOnly && clipboardPolicyProp === sessionSettings.clipboardPolicy) return;
    pendingSessionSettingsRef.current = { viewOnly: viewOnlyProp, clipboardPolicy: clipboardPolicyProp };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewOnlyProp, clipboardPolicyProp]);

  useEffect(() => {
    connectArgsRef.current = {
      ...connectArgsRef.current,
      host,
      port,
      username,
      password,
      networkSettingsJson,
      securityPolicy,
    };
  }, [host, port, username, password, networkSettingsJson, securityPolicy]);

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
      painterRef.current?.dispose();
      painterRef.current = null;
      framebufferSizeRef.current = { width: 0, height: 0 };
      framebufferGenerationRef.current = 0;
      pressedKeysymsRef.current.clear();
      keyCodeKeysymsRef.current.clear();
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

  // VNC-CLIP-001: RealVNC SendInitialClipboard=False — on connect the local
  // clipboard only becomes the baseline; later changes are sent when the
  // user comes back to the session (window focus, pointer enter, canvas
  // focus) or copies inside this WebView. No polling.
  useEffect(() => {
    if (!visible || conn?.status !== "connected" || !allowClipboardSend) return;
    let disposed = false;
    if (viewerRef.current.sendInitialClipboard) {
      void syncLocalClipboardToServer("connect", true);
    } else {
      void readClipboardText()
        .then((text) => {
          if (!disposed && lastSyncedLocalClipboardTextRef.current === null) {
            lastSyncedLocalClipboardTextRef.current = text;
          }
        })
        .catch(() => {});
    }
    const onFocus = () => {
      void syncLocalClipboardToServer("focus", true);
    };
    const onCopy = () => {
      // The clipboard holds the new content after the event completes.
      window.setTimeout(() => {
        void syncLocalClipboardToServer("copy", true);
      }, 0);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
    };
  }, [visible, conn?.status, allowClipboardSend, syncLocalClipboardToServer]);

  // ── Canvas painting ──────────────────────────────────────────────
  // Frames are painted on demand by the painter; a tab that becomes visible
  // paints the frame it withheld while hidden and releases its ACK.
  useEffect(() => {
    if (!visible || conn?.status !== "connected") return;
    getPainter().resume();
  }, [visible, conn?.status, getPainter]);

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

    // Dead-key composition state (see handleKey / handleKeyPress).
    let deadKeyPending = false;
    let composingCode: string | null = null;

    const releaseAllInput = () => {
      deadKeyPending = false;
      composingCode = null;
      stopNativePointerRef.current();
      pressedKeysymsRef.current.forEach((keysym) => {
        // Keys latched from the session menu stay down until toggled off.
        if (!latchedKeysymsRef.current.has(keysym)) sendWsBinary(encodeWsKey(false, keysym));
      });
      pressedKeysymsRef.current.clear();
      keyCodeKeysymsRef.current.clear();
      const last = lastPointerSentRef.current;
      if (last && last.buttons !== 0) {
        sendWsBinary(encodeWsPointer(last.x, last.y, 0));
        lastPointerSentRef.current = { ...last, buttons: 0 };
      }
    };

    const isWindows = getAppPlatform() === "windows";
    const isMenuKey = (e: KeyboardEvent) => {
      const menuKey = viewerRef.current.menuKey;
      return menuKey !== "none" && e.key === menuKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    };
    const sendKey = (down: boolean, keysym: number) => {
      sendWsBinary(encodeWsKey(down, keysym));
      if (down) pressedKeysymsRef.current.add(keysym);
      else pressedKeysymsRef.current.delete(keysym);
    };
    // VNC-INPUT-003 / DEC-VNC-17: Windows reports AltGr as a synthetic
    // ControlLeft immediately followed by AltRight. Hold a ControlLeft press
    // briefly; when AltGr follows at the same timestamp the Ctrl is dropped so
    // the remote sees ISO_Level3_Shift + the character, not Ctrl+Alt+char.
    const flushAltGr = () => {
      const armed = altGrArmedRef.current;
      if (!armed) return;
      window.clearTimeout(armed.timer);
      altGrArmedRef.current = null;
      keyCodeKeysymsRef.current.set("ControlLeft", 0xffe3);
      sendKey(true, 0xffe3);
    };
    flushAltGrRef.current = flushAltGr;

    const handleKey = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (isEditableTarget(e.target, activeEl))
        return;
      if (!isTerminalFocused(containerRef.current, activeEl))
        return;
      if (viewOnly) {
        if (isMenuKey(e) && e.type === "keydown" && !e.repeat) {
          e.preventDefault();
          openSessionMenuRef.current();
        }
        return;
      }

      if (isWindows) {
        const armed = altGrArmedRef.current;
        if (e.type === "keydown" && e.code === "ControlLeft" && !e.repeat) {
          e.preventDefault();
          flushAltGr();
          const timer = window.setTimeout(flushAltGr, ALTGR_FLUSH_MS);
          altGrArmedRef.current = { timeStamp: e.timeStamp, timer };
          return;
        }
        if (armed && e.type === "keydown" && (e.key === "AltGraph" || e.code === "AltRight")
          && e.timeStamp - armed.timeStamp <= ALTGR_PAIR_WINDOW_MS) {
          window.clearTimeout(armed.timer);
          altGrArmedRef.current = null;
          altGrSuppressedCtrlRef.current = true;
        } else if (armed) {
          flushAltGr();
        }
        if (e.type === "keyup" && e.code === "ControlLeft" && altGrSuppressedCtrlRef.current) {
          e.preventDefault();
          altGrSuppressedCtrlRef.current = false;
          return;
        }
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

      // The menu key (F8 by default) opens the session menu, as in RealVNC
      // Viewer ("Send F8" in the menu delivers the key itself).
      if (isMenuKey(e)) {
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

      // VNC-INPUT-003 / DEC-VNC-17: the OS composes a dead key with the next
      // key and reports the result only as keypress (the keydowns say "Dead"
      // and then the bare letter). Neither keydown is sent and neither is
      // default-prevented; the composed character goes out on keypress, the
      // way RealVNC Viewer sends it.
      if (e.type === "keydown" && e.key === "Dead") {
        // A second dead key makes the OS type the accent itself.
        if (deadKeyPending) composingCode = e.code;
        deadKeyPending = !deadKeyPending;
        return;
      }
      if (e.type === "keydown" && deadKeyPending && !modifierKeysymFromKey(e.key)) {
        deadKeyPending = false;
        const plain = (!e.ctrlKey && !e.altKey && !e.metaKey) || e.getModifierState?.("AltGraph");
        if (plain && [...e.key].length === 1) {
          composingCode = e.code;
          return;
        }
      }
      if (e.type === "keyup" && composingCode !== null && e.code === composingCode) {
        composingCode = null;
        e.preventDefault();
        return;
      }

      if (e.type === "keyup" && e.code) {
        // Release exactly what this physical key pressed; a key-up whose
        // key-down went elsewhere (e.g. Esc closing the session menu) is not
        // forwarded, matching RealVNC Viewer.
        const pressed = keyCodeKeysymsRef.current.get(e.code);
        if (pressed === undefined) {
          if (keyEventToKeysym(e) !== 0) e.preventDefault();
          return;
        }
        keyCodeKeysymsRef.current.delete(e.code);
        e.preventDefault();
        sendKey(false, pressed);
        return;
      }
      const keysym = keyEventToKeysym(e);
      if (keysym === 0) return;
      e.preventDefault();
      if (e.type === "keyup") {
        sendKey(false, keysym);
        return;
      }
      if (e.code) keyCodeKeysymsRef.current.set(e.code, keysym);
      sendKey(true, keysym);
    };

    // The character a dead-key sequence produced (see handleKey).
    const handleKeyPress = (e: KeyboardEvent) => {
      if (composingCode === null || viewOnly) return;
      const activeEl = document.activeElement;
      if (isEditableTarget(e.target, activeEl) || !isTerminalFocused(containerRef.current, activeEl)) return;
      const keysym = keyEventToKeysym(e);
      if (keysym === 0) return;
      e.preventDefault();
      sendWsBinary(encodeWsKey(true, keysym));
      sendWsBinary(encodeWsKey(false, keysym));
    };

    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);
    window.addEventListener("keypress", handleKeyPress);

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
      window.removeEventListener("keypress", handleKeyPress);
      window.removeEventListener("paste", handlePaste);
      window.removeEventListener("blur", releaseAllInput);
      document.removeEventListener("visibilitychange", releaseAllInput);
      if (altGrArmedRef.current) {
        window.clearTimeout(altGrArmedRef.current.timer);
        altGrArmedRef.current = null;
      }
      flushAltGrRef.current = () => {};
    };
  }, [visible, conn?.status, viewOnly, allowClipboardSend, sendWs, sendWsBinary]);

  // ── Special keys (VNC-INPUT-003, Windows) ─────────────────────────
  // While the canvas has focus in the foreground window, a low-level
  // keyboard hook in the backend swallows Win, Alt+Tab, Alt+Esc, Ctrl+Esc
  // and PrtScn locally and hands them to this session (RealVNC
  // SendSpecialKeys=True).
  const [windowFocused, setWindowFocused] = useState(() => typeof document === "undefined" || document.hasFocus());
  useEffect(() => {
    const onFocus = () => setWindowFocused(true);
    const onBlur = () => setWindowFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  const captureSpecialKeys = isTauriRuntime()
    && getAppPlatform() === "windows"
    && visible
    && conn?.status === "connected"
    && !viewOnly
    && viewer.passSpecialKeys
    && canvasFocused
    && windowFocused;
  useEffect(() => {
    if (!captureSpecialKeys) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void invoke("vnc_set_special_key_capture", { enabled: true }).catch(() => {});
    void listen<{ code: string; down: boolean }>("vnc-special-key", (event) => {
      const keysym = SPECIAL_KEY_KEYSYMS[event.payload.code];
      if (!keysym || !canvasFocusedRef.current) return;
      // Ctrl+Esc: the Ctrl held back by the AltGr check must reach the
      // remote before the intercepted key, or the remote sees a plain Esc.
      if (event.payload.down) flushAltGrRef.current();
      sendWsBinary(encodeWsKey(event.payload.down, keysym));
      if (event.payload.down) pressedKeysymsRef.current.add(keysym);
      else pressedKeysymsRef.current.delete(keysym);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
      void invoke("vnc_set_special_key_capture", { enabled: false }).catch(() => {});
    };
  }, [captureSpecialKeys, sendWsBinary]);

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

  // VNC-PERF-005 / DEC-VNC-20: Windows delivers cursor moves to the WebView
  // one or two vsync periods late. While the pointer rests over the canvas
  // the relay reads the cursor itself; this panel reports where the canvas
  // is and keeps sending its own events (the relay drops the late copies).
  const nativePointerTarget = useCallback((): VncNativePointerTarget | null => {
    const canvas = canvasRef.current;
    const fbWidth = conn?.width ?? 0;
    const fbHeight = conn?.height ?? 0;
    if (!canvas || fbWidth <= 0 || fbHeight <= 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      dpr: window.devicePixelRatio || 1,
      fb_width: fbWidth,
      fb_height: fbHeight,
    };
  }, [conn?.width, conn?.height]);

  const startNativePointer = useCallback(() => {
    if (!nativePointerAvailableRef.current || viewOnly || conn?.status !== "connected") return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    const target = nativePointerTarget();
    if (!target) return;
    sendWs({ type: "native_pointer", on: true, ...target });
    nativePointerOnRef.current = true;
  }, [conn?.status, nativePointerTarget, sendWs, viewOnly]);

  const stopNativePointer = useCallback(() => {
    if (!nativePointerOnRef.current) return;
    nativePointerOnRef.current = false;
    sendWs({ type: "native_pointer", on: false });
  }, [sendWs]);
  const stopNativePointerRef = useRef(stopNativePointer);
  stopNativePointerRef.current = stopNativePointer;

  // The canvas moved or resized, or the framebuffer changed size: report the
  // new geometry while sampling is on.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || conn?.status !== "connected") return;
    const refresh = () => {
      if (nativePointerOnRef.current) startNativePointer();
    };
    refresh();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
    observer?.observe(canvas);
    window.addEventListener("resize", refresh);
    document.addEventListener("scroll", refresh, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", refresh);
      document.removeEventListener("scroll", refresh, true);
    };
  }, [conn?.status, startNativePointer]);

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
        if (buttons === 0 && mapped.inside && !nativePointerOnRef.current) startNativePointer();
        // Chromium (WebView2) delivers moves earlier as pointerrawupdate;
        // once those arrive, the frame-aligned pointermove is a duplicate.
        if (rawPointerMovesRef.current) return;
        pointerScheduler().move(pointer);
        return;
      }

      pointerScheduler().sendNow(pointer);
    },
    [viewOnly, conn?.status, getFbCoords, pointerScheduler, startNativePointer],
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
  const handlePointerEnter = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (viewOnly || conn?.status !== "connected") return;
    void syncLocalClipboardToServer("enter", true);
    if (e.buttons === 0) startNativePointer();
  }, [viewOnly, conn?.status, syncLocalClipboardToServer, startNativePointer]);

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
  let overlayView: VncOverlayView | null = null;
  if (lifecycle?.kind === "unencrypted") {
    overlayView = { kind: "unencrypted", host, port };
  } else if (lifecycle?.kind === "auth") {
    overlayView = {
      kind: "auth",
      host,
      port,
      username: credentialOverrideRef.current?.username ?? username ?? "",
      error: lifecycle.error,
    };
  } else if (lifecycle?.kind === "reconnecting") {
    overlayView = {
      kind: "reconnecting",
      reason: lifecycle.reason,
      attempt: lifecycle.attempt,
      secondsLeft: Math.max(0, Math.ceil((lifecycle.at - clockNow) / 1000)),
    };
  } else if (conn?.status === "connecting") {
    overlayView = { kind: "connecting", host, port };
  } else if (conn?.status === "disconnected" || conn?.status === "error") {
    overlayView = { kind: "disconnected", reason: conn?.error ?? null };
  }

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
      data-vnc-frames-painted={paintStats?.framesPainted ?? 0}
      data-vnc-full-frame-ms={paintStats?.fullFrame
        ? `${paintStats.fullFrame.receiveMs.toFixed(2)}+${paintStats.fullFrame.paintMs.toFixed(2)}`
        : undefined}
      data-vnc-fullscreen={fullScreen ? "true" : "false"}
      data-vnc-special-keys={captureSpecialKeys ? "captured" : "off"}
      style={{
        width: "100%",
        height: "100%",
        overflow: displaySize.scrolls ? "auto" : "hidden",
        display: "flex",
        backgroundColor: "#1a1a2e",
        position: "relative",
        // Screen-level full screen covers the whole WebView (tab strip, title
        // bar and status bar included) while the OS window is full screen.
        ...(screenFullScreen
          ? { position: "fixed", inset: 0, width: "100vw", height: "100vh", zIndex: 1000 }
          : {}),
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
              onClick={() => changeScaling(scaling === "auto" ? 100 : "auto")}
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

      {/* Status overlays (VNC-SESS-003) */}
      {overlayView && (
        <VncConnectionOverlay
          key={overlayView.kind}
          view={overlayView}
          actions={{
            stop: stopConnecting,
            reconnect: reconnectNow,
            continueUnencrypted: (dontWarnAgain) => {
              if (dontWarnAgain) updateViewer({ warnUnencrypted: false });
              unencryptedConfirmedRef.current = true;
              reconnectNow();
            },
            cancelUnencrypted: () => {
              setLifecycle(null);
              store.setDisconnected(tabId, tr("vnc.unencryptedCancelled"));
            },
            submitCredentials: ({ username: user, password: pass, remember }) => {
              credentialOverrideRef.current = { username: user, password: pass };
              if (remember) onCredentialsChange?.({ username: user, password: pass });
              if (credentialsRetryConfirmedRef.current) unencryptedConfirmedRef.current = true;
              credentialsRetryConfirmedRef.current = false;
              reconnectNow();
            },
            cancelAuth: () => {
              credentialsRetryConfirmedRef.current = false;
              setLifecycle(null);
              store.setDisconnected(tabId, tr("vnc.authCancelled"));
            },
          }}
        />
      )}

      {fullScreen && showCanvas && (
        <VncFullScreenToolbar
          scaledTo100={scaling !== "auto"}
          viewOnly={viewOnly}
          onExitFullScreen={toggleFullScreen}
          onToggleScale={() => changeScaling(scaling === "auto" ? 100 : "auto")}
          onSendCtrlAltDel={sendCtrlAltDel}
          onOpenMenu={(x, y) => openSessionMenu(x, y)}
          onEndSession={closeConnection}
        />
      )}

      <canvas
        ref={canvasRef}
        data-testid="vnc-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointer}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={() => stopNativePointer()}
        onFocus={() => {
          canvasFocusedRef.current = true;
          setCanvasFocused(true);
          if (!viewOnly && conn?.status === "connected") void syncLocalClipboardToServer("canvas-focus");
        }}
        onBlur={() => {
          canvasFocusedRef.current = false;
          setCanvasFocused(false);
        }}
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
            paint: paintStats,
          }}
          onClose={() => setInfoOpen(false)}
        />
      )}
      {propertiesOpen && (
        <VncPropertiesDialog
          initial={{
            viewer: { ...viewer, scaling, preserveAspect },
            viewOnly: pendingSessionSettingsRef.current?.viewOnly ?? viewOnly,
            clipboardPolicy: pendingSessionSettingsRef.current?.clipboardPolicy ?? clipboardPolicy,
          }}
          onClose={() => setPropertiesOpen(false)}
          onApply={(next, reconnect) => {
            setPropertiesOpen(false);
            const qualityChanged = next.viewer.pictureQuality !== viewer.pictureQuality;
            setScaling(next.viewer.scaling);
            setPreserveAspect(next.viewer.preserveAspect);
            viewerRef.current = next.viewer;
            setViewer(next.viewer);
            if (qualityChanged) sendWsBinary(encodeWsQuality(pictureQualityWire(next.viewer.pictureQuality)));
            if (next.viewOnly !== viewOnly || next.clipboardPolicy !== clipboardPolicy) {
              pendingSessionSettingsRef.current = { viewOnly: next.viewOnly, clipboardPolicy: next.clipboardPolicy };
            }
            onSessionPropertiesChange?.(next);
            if (reconnect) reconnectNow();
          }}
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
