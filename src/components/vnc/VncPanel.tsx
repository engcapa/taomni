import { ExternalLink, Maximize, Maximize2, Menu as MenuIcon, Minimize, Minimize2, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t as tr, useT } from "../../lib/i18n";
import type { VncScaling, WsOutgoing } from "../../lib/vnc";
import {
  codePointToKeysym,
  encodeWsAck,
  encodeWsKey,
  encodeWsQuality,
  encodeWsRefresh,
  normalizeVncScaling,
  VNC_KEYSYM,
  vncDisconnect,
  VncWheelAccumulator,
} from "../../lib/vnc";
import { VncFramePainter } from "../../lib/vncFramePainter";
import { DEFAULT_VNC_VIEWER_OPTIONS, pictureQualityWire, type VncPictureQuality, type VncViewerOptions } from "../../lib/vncOptions";
import { VncPointerScheduler, type VncPointerState } from "../../lib/vncPointerScheduler";
import { useVncStore } from "../../stores/vncStore";
import { useContextMenu } from "../ContextMenu";
import { FT_BUTTON_STYLE, FT_ICON_BUTTON_STYLE, FT_SEPARATOR_STYLE } from "../floating-toolbar/floatingToolbarStyles";
import { ScreenshotMenuButton } from "../screenshot/ScreenshotMenuButton";
import { TabActions } from "../tabbar/TabActionSlot";
import { CLIPBOARD_KEYSTROKE_BATCH, CLIPBOARD_KEYSTROKE_LIMIT, CLIPBOARD_SYNC_MIN_INTERVAL_MS, readVncClipboardText } from "./panel/clipboardPolicy";
import { networkSettingsUsesTunnel } from "./panel/connectionPolicy";
import { type DelayedPointerDown, type VncPanelProps } from "./panel/types";
import { useVncConnection } from "./panel/useVncConnection";
import { useVncFullScreen } from "./panel/useVncFullScreen";
import { useVncKeyboard } from "./panel/useVncKeyboard";
import { useVncPointer } from "./panel/useVncPointer";
import { useVncSpecialKeys } from "./panel/useVncSpecialKeys";
import { useVncViewport } from "./panel/useVncViewport";
import { VncConnectionOverlay, type VncOverlayView } from "./VncConnectionOverlay";
import { VncFullScreenToolbar } from "./VncFullScreenToolbar";
import { VncPropertiesDialog } from "./VncPropertiesDialog";
import { VncSessionInfoDialog } from "./VncSessionInfoDialog";
import { buildVncSessionMenuItems } from "./vncSessionMenu";

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
  const pressedKeysymsRef = useRef(new Set<number>());
  // Physical key (KeyboardEvent.code) -> keysym sent on its key-down.
  const keyCodeKeysymsRef = useRef(new Map<string, number>());
  const painterRef = useRef<VncFramePainter | null>(null);
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
  const [scaling, setScaling] = useState<VncScaling>(() =>
    normalizeVncScaling(viewerOptionsProp?.scaling ?? initialScaling));
  const [preserveAspect, setPreserveAspect] = useState(() => viewerOptionsProp?.preserveAspect ?? true);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const serverClipboardGraceUntilRef = useRef(0);
  const canvasFocusedRef = useRef(false);
  const [canvasFocused, setCanvasFocused] = useState(false);
  const [ctrlLatched, setCtrlLatched] = useState(false);
  const [altLatched, setAltLatched] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const wheelAccumulatorRef = useRef(new VncWheelAccumulator());
  // True once the WebView delivers pointerrawupdate for this canvas.
  const rawPointerMovesRef = useRef(false);
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
        // Publish actual paints even when an idle server sends no more stats.
        // Updating the diagnostic attribute avoids a React render per frame.
        onFramePainted: (count) => {
          containerRef.current?.setAttribute("data-vnc-frames-painted", String(count));
        },
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
  const { fullScreen, canFullScreen, toggleFullScreen, screenFullScreen } = useVncFullScreen({
    detachedWindowControls,
    visible,
  });

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
    if (sid) void vncDisconnect(sid).catch(() => { });
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
  const sendClipboardAsKeysRef = useRef<() => void>(() => { });
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
          text = await readVncClipboardText();
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
        text = await readVncClipboardText();
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
      for (let index = 0;index < keysyms.length;index += CLIPBOARD_KEYSTROKE_BATCH) {
        if (destroyedRef.current || wsRef.current?.readyState !== WebSocket.OPEN) return;
        keysyms.slice(index, index + CLIPBOARD_KEYSTROKE_BATCH).forEach((keysym) => {
          sendWsBinary(encodeWsKey(true, keysym));
          sendWsBinary(encodeWsKey(false, keysym));
        });
        await new Promise((resolve) => window.setTimeout(resolve, 16));
      }
    })();
  };
  const {
    stopConnecting,
    reconnectNow,
    wsRef,
    sessionIdRef,
    framebufferSizeRef,
    destroyedRef,
    suppressReconnectRef,
    credentialOverrideRef,
    unencryptedConfirmedRef,
    unencryptedAcceptedRef,
    credentialsRetryConfirmedRef,
    lifecycle,
    setLifecycle,
    clockNow,
    reconnectTimerRef,
    extClipboardSupportedRef,
    sessionStats,
    paintStats,
    nativePointerAvailableRef,
    nativePointerOnRef,
    remoteCursorCss,
  } = useVncConnection({
    store,
    tabId,
    pendingSessionSettingsRef,
    setSessionSettings,
    viewerRef,
    painterRef,
    pointerSchedulerRef,
    lastPointerSentRef,
    getPainter,
    allowClipboardReceive,
    serverClipboardGraceUntilRef,
    serverClipboardWriteInFlightRef,
    lastSyncedLocalClipboardTextRef,
    host,
    port,
    username,
    password,
    networkSettingsJson,
    securityPolicy,
    viewOnly,
    clipboardPolicy,
    viewOnlyProp,
    sessionSettings,
    clipboardPolicyProp,
    pressedKeysymsRef,
    keyCodeKeysymsRef,
    pasteDelayTimerRef,
    delayedPointerDownRef,
    pasteInFlightRef,
    clipboardSyncPromiseRef,
    lastClipboardSyncCheckAtRef,
  });

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
      void readVncClipboardText()
        .then((text) => {
          if (!disposed && lastSyncedLocalClipboardTextRef.current === null) {
            lastSyncedLocalClipboardTextRef.current = text;
          }
        })
        .catch(() => { });
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
  const { flushAltGrRef } = useVncKeyboard({
    visible,
    conn,
    sendWs,
    pasteInFlightRef,
    lastSyncedLocalClipboardTextRef,
    extClipboardSupportedRef,
    destroyedRef,
    pasteDelayTimerRef,
    sendWsBinary,
    get stopNativePointerRef() { return stopNativePointerRef; },
    pressedKeysymsRef,
    latchedKeysymsRef,
    keyCodeKeysymsRef,
    lastPointerSentRef,
    viewerRef,
    containerRef,
    viewOnly,
    openSessionMenuRef,
    allowClipboardSend,
  });
  const { captureSpecialKeys } = useVncSpecialKeys({
    visible,
    conn,
    viewOnly,
    viewer,
    canvasFocused,
    canvasFocusedRef,
    flushAltGrRef,
    sendWsBinary,
    pressedKeysymsRef,
  });
  const { stopNativePointerRef, handlePointerDown, handlePointer, handlePointerUp, handlePointerEnter, stopNativePointer } = useVncPointer({
    canvasRef,
    conn,
    lastPointerSentRef,
    sendWsBinary,
    pointerSchedulerRef,
    nativePointerAvailableRef,
    viewOnly,
    wsRef,
    sendWs,
    nativePointerOnRef,
    delayedPointerDownRef,
    rawPointerMovesRef,
    syncLocalClipboardToServer,
    clipboardSyncPromiseRef,
    destroyedRef,
    wheelAccumulatorRef,
  });
  const { displaySize, canvasStyle } = useVncViewport({
    containerRef,
    scaling,
    conn,
    preserveAspect,
    remoteCursorCss,
  });

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

  return (
    <div
      ref={containerRef}
      className="vnc-container"
      data-testid="vnc-panel"
      data-vnc-scaling={String(scaling)}
      data-vnc-frames-painted="0"
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
          the connection state. System capture lives in the main window bar
          or the detached window's action slot. */}
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
            <ScreenshotMenuButton />
            <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
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
              unencryptedAcceptedRef.current = true;
              reconnectNow();
            },
            cancelUnencrypted: () => {
              unencryptedAcceptedRef.current = false;
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

export { type VncPanelProps } from "./panel/types";
