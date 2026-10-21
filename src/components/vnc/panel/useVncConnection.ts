import type { useVncStore } from "../../../stores/vncStore";
import { useState, useEffect, useRef, useCallback } from "react";
import { vncConnect, vncCancelConnect, vncDisconnect, encodeWsPing, parseWsMessage, parseVncError, vncCursorToCss } from "../../../lib/vnc";
import type { VncSessionStats } from "../../../lib/vnc";
import { VncFramePainter, type VncPaintStats } from "../../../lib/vncFramePainter";
import { type VncViewerOptions } from "../../../lib/vncOptions";
import { VncPointerScheduler, type VncPointerState } from "../../../lib/vncPointerScheduler";
import { writeMultiFormat, writeText as writeClipboardText } from "../../../lib/clipboard";
import { t as tr } from "../../../lib/i18n";
import { type DelayedPointerDown } from "./types";
import { SERVER_CLIPBOARD_GRACE_MS } from "./clipboardPolicy";
import { newAttemptId, RECONNECT_STABLE_MS, RECONNECT_DELAYS_MS } from "./connectionPolicy";
import { playBell } from "./bell";


export interface UseVncConnectionContext {
  store: ReturnType<typeof useVncStore.getState>;
  tabId: string;
  pendingSessionSettingsRef: import("react").RefObject<{ viewOnly: boolean; clipboardPolicy: import("../../../lib/vnc").VncClipboardPolicy; } | null>;
  setSessionSettings: import("react").Dispatch<import("react").SetStateAction<{ viewOnly: boolean; clipboardPolicy: import("../../../lib/vnc").VncClipboardPolicy; }>>;
  viewerRef: import("react").RefObject<VncViewerOptions>;
  painterRef: import("react").RefObject<VncFramePainter | null>;
  pointerSchedulerRef: import("react").RefObject<VncPointerScheduler | null>;
  lastPointerSentRef: import("react").RefObject<VncPointerState | null>;
  getPainter: () => VncFramePainter;
  allowClipboardReceive: boolean;
  serverClipboardGraceUntilRef: import("react").RefObject<number>;
  serverClipboardWriteInFlightRef: import("react").RefObject<number>;
  lastSyncedLocalClipboardTextRef: import("react").RefObject<string | null>;
  host: string;
  port: number;
  username: string | null | undefined;
  password: string | undefined;
  networkSettingsJson: string | null | undefined;
  securityPolicy: import("../../../lib/vnc").VncSecurityPolicy | undefined;
  viewOnly: boolean;
  clipboardPolicy: import("../../../lib/vnc").VncClipboardPolicy;
  viewOnlyProp: boolean;
  sessionSettings: { viewOnly: boolean; clipboardPolicy: import("../../../lib/vnc").VncClipboardPolicy; };
  clipboardPolicyProp: import("../../../lib/vnc").VncClipboardPolicy;
  pressedKeysymsRef: import("react").RefObject<Set<number>>;
  keyCodeKeysymsRef: import("react").RefObject<Map<string, number>>;
  pasteDelayTimerRef: import("react").RefObject<number | null>;
  delayedPointerDownRef: import("react").RefObject<DelayedPointerDown | null>;
  pasteInFlightRef: import("react").RefObject<{ pasteKeysym: number; heldModifiers: Set<number>; deferredKeyUps: Set<number>; } | null>;
  clipboardSyncPromiseRef: import("react").RefObject<Promise<void> | null>;
  lastClipboardSyncCheckAtRef: import("react").RefObject<number>;
}

export function useVncConnection(context: UseVncConnectionContext) {
  const {
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
  } = context;

  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const framebufferSizeRef = useRef({ width: 0, height: 0 });
  const framebufferGenerationRef = useRef(0);
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
  const credentialOverrideRef = useRef<{ username: string; password: string; } | null>(null);
  // The user accepted the unencrypted-connection warning for the next attempt.
  const unencryptedConfirmedRef = useRef(false);
  // The user accepted the unencrypted-connection warning for this session. An
  // automatic reconnect after a dropped connection repeats the same connection
  // the user already approved, so it must not stop on that dialog again while
  // AutoReconnect is doing the reconnecting.
  const unencryptedAcceptedRef = useRef(false);
  // DEC-VNC-21: the attempt that stopped to ask for credentials had already
  // passed the unencrypted warning, so the retry with them does not ask again.
  const credentialsRetryConfirmedRef = useRef(false);
  const attemptIdRef = useRef<string | null>(null);
  const [lifecycle, setLifecycle] = useState<
    | { kind: "unencrypted"; }
    | { kind: "auth"; error: string | null; }
    | { kind: "reconnecting"; attempt: number; at: number; reason: string | null; }
    | null
  >(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const heartbeatTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectStableTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectGenerationRef = useRef(0);
  // Tracks whether the connected server negotiated the ExtendedClipboard
  // pseudo-encoding. Stored as a ref so input handlers read the latest value
  // without re-binding.
  const extClipboardSupportedRef = useRef<boolean>(false);
  const cursorShapeReceivedRef = useRef(false);
  const [sessionStats, setSessionStats] = useState<VncSessionStats | null>(null);
  const [paintStats, setPaintStats] = useState<VncPaintStats | null>(null);
  // VNC-PERF-005: the relay offers native cursor sampling (Windows); while it
  // is on, the relay sends plain moves and this panel sends buttons only.
  const nativePointerAvailableRef = useRef(false);
  const nativePointerOnRef = useRef(false);
  const [remoteCursorCss, setRemoteCursorCss] = useState("none");


  const scheduleReconnectRef = useRef<(reason?: string | null) => void>(() => { });

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
      void vncDisconnect(previousSessionId).catch(() => { });
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
          vncDisconnect(result.session_id).catch(() => { });
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
                  .catch(() => { })
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
                  .catch(() => { })
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
      if (destroyedRef.current) return;
      // Only this automatic attempt inherits the warning the user accepted for
      // the session. An explicit Reconnect (or any other user-driven attempt)
      // must ask again, so the confirmation is set immediately before the
      // automatic connect and never left pending for later attempts.
      if (unencryptedAcceptedRef.current) unencryptedConfirmedRef.current = true;
      doConnect();
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
    // Stopping ends this session's approval; a later connection asks again.
    unencryptedAcceptedRef.current = false;
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
        vncDisconnect(sid).catch(() => { });
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      store.removeConnection(tabId);
    };
  }, []);
  return { stopConnecting, reconnectNow, wsRef, sessionIdRef, framebufferSizeRef, framebufferGenerationRef, destroyedRef, suppressReconnectRef, connectArgsRef, credentialOverrideRef, unencryptedConfirmedRef, unencryptedAcceptedRef, credentialsRetryConfirmedRef, attemptIdRef, lifecycle, setLifecycle, clockNow, setClockNow, heartbeatTimerRef, reconnectTimerRef, reconnectStableTimerRef, reconnectAttemptRef, connectGenerationRef, extClipboardSupportedRef, cursorShapeReceivedRef, sessionStats, setSessionStats, paintStats, setPaintStats, nativePointerAvailableRef, nativePointerOnRef, remoteCursorCss, setRemoteCursorCss };
}
