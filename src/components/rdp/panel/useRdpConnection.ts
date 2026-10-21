import { useCallback, useEffect, useRef } from "react";
import { confirmAppDialog } from "../../../lib/appDialogs";
import { writeFiles as writeClipboardFiles, writeText as writeClipboardText } from "../../../lib/clipboard";
import { t as tr, useT } from "../../../lib/i18n";
import {
  encodeAck,
  encodePing,
  encodeRefresh,
  encodeResize,
  extractRdpCertificateChallenge,
  formatRdpCertificateFingerprint,
  isRetryableRdpConnectError,
  normalizeRdpResizeSize,
  OUT_AUDIO,
  OUT_CURSOR,
  OUT_FRAME,
  OUT_FRAME_END,
  parseAudioFrame,
  parseFrameTile,
  parseRdpCursorFrame,
  parseRdpWsText,
  rdpConnect,
  rdpCursorToCss,
  rdpDisconnect,
  RdpFrameBatchBuffer,
  rdpTrustCertificate,
  type RdpNetworkInfo,
} from "../../../lib/rdp";
import type { useRdpStore } from "../../../stores/rdpStore";
import { drawTileBatch, resizeCanvas } from "./canvas";
import { useRdpAudio } from "./useRdpAudio";

export interface UseRdpConnectionContext {
  visible: boolean;
  store: ReturnType<typeof useRdpStore.getState>;
  tabId: string;
  t: ReturnType<typeof useT>;
  viewportRef: import("react").RefObject<HTMLDivElement | null>;
  initRef: import("react").RefObject<{ host: string; port: number; username: string | null | undefined; password: string | undefined; options: import("../../../types/rdp").RdpOptions; networkSettingsJson: string | null | undefined; }>;
  setRemoteCursorCss: import("react").Dispatch<import("react").SetStateAction<string>>;
  canvasRef: import("react").RefObject<HTMLCanvasElement | null>;
  audio: ReturnType<typeof useRdpAudio>;
  setNetwork: import("react").Dispatch<import("react").SetStateAction<RdpNetworkInfo | null>>;
  host: string;
  port: number;
  username: string | null | undefined;
  password: string | undefined;
  options: import("../../../types/rdp").RdpOptions;
  networkSettingsJson: string | null | undefined;
  conn: import("../../../stores/rdpStore").RdpConnectionState;
}

export function useRdpConnection(context: UseRdpConnectionContext) {
  const {
    visible,
    store,
    tabId,
    t,
    viewportRef,
    initRef,
    setRemoteCursorCss,
    canvasRef,
    audio,
    setNetwork,
    host,
    port,
    username,
    password,
    options,
    networkSettingsJson,
    conn,
  } = context;
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectedAtRef = useRef(0);
  const retryAllowedRef = useRef(true);
  const lastResizeRequestRef = useRef<string | null>(null);
  const destroyedRef = useRef(false);
  const certificatePromptRef = useRef(false);
  const reconnectRef = useRef<() => void>(() => { });
  const visibleRef = useRef(visible);
  const suppressNextPasteKeyUpRef = useRef(false);
  const pressedScancodesRef = useRef(new Set<number>());
  const frameBatchRef = useRef(new RdpFrameBatchBuffer());
  const composingRef = useRef(false);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const handleAutomaticReconnect = useCallback(
    (reason: string): boolean => {
      if (destroyedRef.current || certificatePromptRef.current || !retryAllowedRef.current) {
        return false;
      }
      if (reconnectTimerRef.current !== null) return true;
      if (reconnectAttemptsRef.current >= 3) {
        store.setDisconnected(tabId, reason);
        return true;
      }

      reconnectAttemptsRef.current += 1;
      const attempt = reconnectAttemptsRef.current;
      const delay = 500 * 2 ** (attempt - 1);
      store.initConnection(tabId);
      store.setStage(tabId, t("rdp.autoReconnect", { attempt }));
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!destroyedRef.current) reconnectRef.current();
      }, delay);
      return true;
    },
    [store, t, tabId],
  );

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

  const releaseRemoteInput = useCallback(() => {
    pressedScancodesRef.current.clear();
    suppressNextPasteKeyUpRef.current = false;
    sendText({ type: "release_input" });
  }, [sendText]);

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

  /* ── Connect lifecycle ───────────────────────────────────────────── */

  const doConnect = useCallback(() => {
    const args = initRef.current;
    destroyedRef.current = false;
    lastResizeRequestRef.current = null;
    retryAllowedRef.current = true;
    frameBatchRef.current.reset();
    setRemoteCursorCss("default");
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
          rdpDisconnect(result.session_id).catch(() => { });
          return;
        }
        sessionIdRef.current = result.session_id;
        store.setConnecting(tabId, result.session_id, result.ws_port);

        const ws = new WebSocket(`ws://127.0.0.1:${result.ws_port}`, [
          `taomni-rdp.${result.ws_token}`,
        ]);
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
          if (destroyedRef.current || wsRef.current !== ws) return;
          if (event.data instanceof ArrayBuffer) {
            const dv = new DataView(event.data);
            if (event.data.byteLength === 0) return;
            const tag = dv.getUint8(0);
            if (tag === OUT_FRAME) {
              const tile = parseFrameTile(event.data);
              const canvas = canvasRef.current;
              frameBatchRef.current.push(tile, canvas?.width ?? 0, canvas?.height ?? 0);
            } else if (tag === OUT_FRAME_END) {
              const batch = frameBatchRef.current.finish();
              if (batch.refreshRequired) {
                sendBinary(encodeRefresh());
                return;
              }
              drawTileBatch(canvasRef.current, batch.tiles);
              if (visibleRef.current) sendBinary(encodeAck());
            } else if (tag === OUT_AUDIO) {
              audio.playAudioFrame(parseAudioFrame(event.data));
            } else if (tag === OUT_CURSOR) {
              const cursor = parseRdpCursorFrame(event.data);
              if (cursor) setRemoteCursorCss(rdpCursorToCss(cursor));
            }
          } else {
            const msg = parseRdpWsText(event.data as string);
            if (!msg) return;
            switch (msg.type) {
              case "connected":
                connectedAtRef.current = Date.now();
                retryAllowedRef.current = true;
                setNetwork(null);
                store.setConnected(tabId, msg.width, msg.height, msg.protocol, msg.server_name);
                frameBatchRef.current.reset();
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
              case "network":
                setNetwork({
                  baseRttMs: msg.baseRttMs ?? null,
                  averageRttMs: msg.averageRttMs,
                  bandwidthKbps: msg.bandwidthKbps ?? null,
                });
                break;
              case "error":
                {
                  const challenge = extractRdpCertificateChallenge(msg.message);
                  if (certificatePromptRef.current) break;
                  if (!challenge) {
                    retryAllowedRef.current = msg.retryable === true;
                    store.setDisconnected(tabId, msg.message);
                    // The native worker has ended, but its relay can stay
                    // open awaiting controls. Release it explicitly so the
                    // close handler cleans up and applies the bounded retry
                    // policy instead of leaving a transient error stranded.
                    ws.close();
                    break;
                  }
                  retryAllowedRef.current = false;
                  clearReconnectTimer();
                  certificatePromptRef.current = true;
                  store.setStage(tabId, "certificate-review");
                  void (async () => {
                    const fingerprint = formatRdpCertificateFingerprint(challenge.observed);
                    const confirmed = await confirmAppDialog({
                      title: t(
                        challenge.changed
                          ? "rdp.certificateChangedTitle"
                          : "rdp.certificateTrustTitle",
                      ),
                      message: t(
                        challenge.changed
                          ? "rdp.certificateChangedMessage"
                          : "rdp.certificateTrustMessage",
                        {
                          host: challenge.host,
                          port: challenge.port,
                          fingerprint,
                        },
                      ),
                      confirmLabel: t("rdp.certificateTrustConfirm"),
                      danger: challenge.changed,
                    });
                    if (!confirmed || destroyedRef.current) {
                      certificatePromptRef.current = false;
                      store.setDisconnected(tabId, t("rdp.certificateTrustDeclined"));
                      return;
                    }
                    try {
                      await rdpTrustCertificate(
                        challenge.host,
                        challenge.port,
                        challenge.observed,
                      );
                      const oldSession = sessionIdRef.current;
                      sessionIdRef.current = null;
                      if (oldSession) await rdpDisconnect(oldSession).catch(() => { });
                      const currentWs = wsRef.current;
                      wsRef.current = null;
                      currentWs?.close();
                      reconnectAttemptsRef.current = 0;
                      certificatePromptRef.current = false;
                      window.setTimeout(() => reconnectRef.current(), 0);
                    } catch (err) {
                      certificatePromptRef.current = false;
                      store.setDisconnected(tabId, String(err));
                    }
                  })();
                }
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
                    void writeClipboardText(msg.text).catch(() => { });
                  }
                });
                break;
            }
          }
        };

        ws.onclose = () => {
          if (wsRef.current !== ws) return;
          audio.closeAudio();
          pressedScancodesRef.current.clear();
          wsRef.current = null;
          if (heartbeatRef.current !== null) {
            window.clearInterval(heartbeatRef.current);
            heartbeatRef.current = null;
          }
          const sid = sessionIdRef.current;
          sessionIdRef.current = null;
          if (sid) void rdpDisconnect(sid).catch(() => { });
          if (connectedAtRef.current > 0 && Date.now() - connectedAtRef.current >= 30_000) {
            reconnectAttemptsRef.current = 0;
          }
          connectedAtRef.current = 0;
          if (destroyedRef.current || certificatePromptRef.current) return;
          const reason = tr("rdp.closedConnection");
          if (!retryAllowedRef.current) return;
          if (!handleAutomaticReconnect(reason)) store.setDisconnected(tabId, reason);
        };
        ws.onerror = () => {
          if (!destroyedRef.current && wsRef.current === ws) {
            store.setStage(tabId, "websocket-error");
          }
        };
      } catch (err) {
        if (!cancelled && !destroyedRef.current) {
          const reason = String(err);
          retryAllowedRef.current = isRetryableRdpConnectError(err);
          if (!handleAutomaticReconnect(reason)) store.setDisconnected(tabId, reason);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    clearReconnectTimer,
    audio.closeAudio,
    handleAutomaticReconnect,
    audio.playAudioFrame,
    requestViewportResize,
    sendBinary,
    store,
    tabId,
  ]);

  reconnectRef.current = doConnect;

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
      clearReconnectTimer();
      if (heartbeatRef.current !== null) {
        window.clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      audio.closeAudio();
      releaseRemoteInput();
      frameBatchRef.current.reset();
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sid) rdpDisconnect(sid).catch(() => { });
      const currentWs = wsRef.current;
      wsRef.current = null;
      currentWs?.close();
      store.removeConnection(tabId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) releaseRemoteInput();
  }, [releaseRemoteInput, visible]);

  useEffect(() => {
    const release = () => releaseRemoteInput();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") release();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [releaseRemoteInput]);

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

  const reconnect = useCallback(() => {
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    connectedAtRef.current = 0;
    const sid = sessionIdRef.current;
    sessionIdRef.current = null;
    if (sid) rdpDisconnect(sid).catch(() => { });
    const currentWs = wsRef.current;
    wsRef.current = null;
    currentWs?.close();
    audio.closeAudio();
    store.setDisconnected(tabId);
    doConnect();
  }, [clearReconnectTimer, audio.closeAudio, doConnect, store, tabId]);

  // Connection bar "disconnect": end the session without an automatic
  // reconnect; the tab stays open and Reconnect starts a new session. A
  // user-chosen disconnect is not an error, so no reason is recorded.
  const disconnectSession = useCallback(() => {
    clearReconnectTimer();
    retryAllowedRef.current = false;
    const sid = sessionIdRef.current;
    sessionIdRef.current = null;
    if (sid) rdpDisconnect(sid).catch(() => { });
    const currentWs = wsRef.current;
    wsRef.current = null;
    currentWs?.close();
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    audio.closeAudio();
    store.setDisconnected(tabId);
  }, [clearReconnectTimer, audio.closeAudio, store, tabId]);
  return {
    sendText,
    sendBinary,
    requestViewportResize,
    composingRef,
    suppressNextPasteKeyUpRef,
    pressedScancodesRef,
    releaseRemoteInput,
    reconnect,
    disconnectSession,
  };
}
