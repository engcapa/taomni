import { getCurrentWindow } from "@tauri-apps/api/window";
import { Fullscreen, Minimize2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { type RdpNetworkInfo } from "../../lib/rdp";
import { isTauriRuntime } from "../../lib/runtime";
import { useRdpStore } from "../../stores/rdpStore";
import { RdpPanelView } from "./panel/RdpPanelView";
import { type RdpPanelProps, type ScaleMode, type ViewMode } from "./panel/types";
import { useRdpAudio } from "./panel/useRdpAudio";
import { useRdpConnection } from "./panel/useRdpConnection";
import { useRdpInput } from "./panel/useRdpInput";

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
  chatToggle,
  detachedWindowControls,
}: RdpPanelProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imeInputRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const initRef = useRef({ host, port, username, password, options, networkSettingsJson });
  const [scaleMode, setScaleMode] = useState<ScaleMode>("fit");
  const [remoteCursorCss, setRemoteCursorCss] = useState("default");
  // Tracks whether the host OS window is fullscreen. Only meaningful for
  // attached tabs (detached windows manage their own fullscreen via
  // `detachedWindowControls`). Cosmetic — drives the toolbar icon.
  const [osFullscreen, setOsFullscreen] = useState(false);
  // Server network characteristics for the full-screen connection bar, and a
  // counter that reveals the bar again (Ctrl+Alt+Home).
  const [network, setNetwork] = useState<RdpNetworkInfo | null>(null);
  const [barReveal, setBarReveal] = useState(0);

  const store = useRdpStore();
  const conn = store.connections[tabId];
  const audio = useRdpAudio({
    initRef,
  });
  const connection = useRdpConnection({
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
  });

  /* ── View controls (local, never forwarded to the remote) ────────── */

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
          // On Windows a borderless (decorations:false) window that is
          // OS-*maximized* does not cleanly escape the maximized state when
          // `setFullscreen(true)` is called: the window covers the screen but
          // the webview surface stays at the work-area height (screen minus
          // taskbar), leaving a black band where the taskbar used to be. Drop
          // out of maximize first so the surface grows to the true screen
          // height before we go fullscreen.
          if (next && (await w.isMaximized())) {
            await w.unmaximize();
          }
          await w.setFullscreen(next);
          setOsFullscreen(next);
          // The surface resize lands a frame or two after setFullscreen
          // resolves; re-sync the remote desktop to the new viewport so the
          // RDP session repaints at the full screen size instead of the stale
          // work-area size.
          window.setTimeout(() => connection.requestViewportResize(true), 120);
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
        window.setTimeout(() => connection.requestViewportResize(true), 120);
      } catch {
        /* fullscreen request rejected — ignore */
      }
    })();
  }, [detachedWindowControls, connection.requestViewportResize]);

  const minimizeWindow = useCallback(() => {
    if (!isTauriRuntime()) return;
    void getCurrentWindow()
      .minimize()
      .catch(() => { });
  }, []);
  const input = useRdpInput({
    connection,
    visible,
    conn,
    toggleOsFullscreen,
    detachedWindowControls,
    osFullscreen,
    setBarReveal,
    canvasRef,
  });

  /* ── Render ──────────────────────────────────────────────────────── */

  const status = conn?.status ?? "disconnected";
  const stage = conn?.stage;
  const dims = conn ? `${conn.width}×${conn.height}` : "";
  const protocol = conn?.protocol ?? "";
  // The backend emits granular internal stage strings (e.g. "negotiating",
  // "credssp", "refresh-requested") that are useful as live progress while we
  // are still connecting, but read as noise once the desktop is up. Show the
  // stage only during connection so the badge settles to a clean
  // "Connected · TLS · 1920×1000" once the session is live.
  const showStage = status === "connecting" && !!stage;

  const canvasClass = useMemo(
    () => (scaleMode === "fit" ? "rdp-canvas rdp-canvas-fit" : "rdp-canvas rdp-canvas-one"),
    [scaleMode],
  );

  /* ── View toggle: normal <-> OS fullscreen ───────────────────────────
   * Derived from the underlying boolean so it stays correct even when the
   * user flips it out-of-band via F11. */
  const currentFullscreen = detachedWindowControls
    ? detachedWindowControls.osFullscreen
    : osFullscreen;
  const viewMode: ViewMode = currentFullscreen ? "fullscreen" : "normal";

  const cycleView = () => toggleOsFullscreen();

  // Icon + tooltip describe what the NEXT click does, so the single button
  // still reads at a glance.
  const cycle =
    viewMode === "fullscreen"
      ? { icon: <Minimize2 size={14} />, label: t("rdp.restore"), hint: " (F11)" }
      : { icon: <Fullscreen size={14} />, label: t("rdp.osFullscreen"), hint: " (F11)" };

  return <RdpPanelView
    containerRef={containerRef}
    input={input}
    connection={connection}
    visible={visible}
    t={t}
    status={status}
    protocol={protocol}
    dims={dims}
    showStage={showStage}
    stage={stage}
    chatToggle={chatToggle}
    onDetach={onDetach}
    setScaleMode={setScaleMode}
    scaleMode={scaleMode}
    cycleView={cycleView}
    cycle={cycle}
    detachedWindowControls={detachedWindowControls}
    currentFullscreen={currentFullscreen}
    conn={conn}
    host={host}
    network={network}
    barReveal={barReveal}
    minimizeWindow={minimizeWindow}
    toggleOsFullscreen={toggleOsFullscreen}
    viewportRef={viewportRef}
    canvasRef={canvasRef}
    canvasClass={canvasClass}
    imeInputRef={imeInputRef}
    remoteCursorCss={remoteCursorCss}
  />;
}

export { type RdpPanelProps } from "./panel/types";
