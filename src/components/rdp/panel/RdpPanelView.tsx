import { Bot, PictureInPicture, PictureInPicture2, RefreshCw } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { type RdpNetworkInfo } from "../../../lib/rdp";
import { FT_BUTTON_ACTIVE_OVERRIDE, FT_BUTTON_STYLE, FT_ICON_BUTTON_STYLE, FT_SEPARATOR_STYLE } from "../../floating-toolbar/floatingToolbarStyles";
import { ScreenshotMenuButton } from "../../screenshot/ScreenshotMenuButton";
import { TabActions } from "../../tabbar/TabActionSlot";
import { RdpConnectionBar } from "../RdpConnectionBar";
import { type ScaleMode } from "./types";
import { useRdpConnection } from "./useRdpConnection";
import { useRdpInput } from "./useRdpInput";

export interface RdpPanelViewProps {
  containerRef: import("react").RefObject<HTMLDivElement | null>;
  input: ReturnType<typeof useRdpInput>;
  connection: ReturnType<typeof useRdpConnection>;
  visible: boolean;
  t: ReturnType<typeof useT>;
  status: import("../../../stores/rdpStore").RdpConnectionStatus;
  protocol: string;
  dims: string;
  showStage: boolean;
  stage: string | null;
  chatToggle: { open: boolean; onToggle: () => void; } | undefined;
  onDetach: (() => void) | undefined;
  setScaleMode: import("react").Dispatch<import("react").SetStateAction<ScaleMode>>;
  scaleMode: ScaleMode;
  cycleView: () => void;
  cycle: { icon: import("react").JSX.Element; label: string; hint: string; };
  detachedWindowControls: { onReattach: () => void; onToggleOsFullscreen: () => void; osFullscreen: boolean; } | undefined;
  currentFullscreen: boolean;
  conn: import("../../../stores/rdpStore").RdpConnectionState;
  host: string;
  network: RdpNetworkInfo | null;
  barReveal: number;
  minimizeWindow: () => void;
  toggleOsFullscreen: () => void;
  viewportRef: import("react").RefObject<HTMLDivElement | null>;
  canvasRef: import("react").RefObject<HTMLCanvasElement | null>;
  canvasClass: "rdp-canvas rdp-canvas-fit" | "rdp-canvas rdp-canvas-one";
  imeInputRef: import("react").RefObject<HTMLTextAreaElement | null>;
  remoteCursorCss: string;
}

export function RdpPanelView(inputs: RdpPanelViewProps) {
  const {
    containerRef,
    input,
    connection,
    visible,
    t,
    status,
    protocol,
    dims,
    showStage,
    stage,
    chatToggle,
    onDetach,
    setScaleMode,
    scaleMode,
    cycleView,
    cycle,
    detachedWindowControls,
    currentFullscreen,
    conn,
    host,
    network,
    barReveal,
    minimizeWindow,
    toggleOsFullscreen,
    viewportRef,
    canvasRef,
    canvasClass,
    imeInputRef,
    remoteCursorCss,
  } = inputs;
  return ((
    <div
      ref={containerRef}
      className="rdp-panel"
      data-testid="rdp-panel"
      tabIndex={0}
      onKeyDown={input.onKey(true)}
      onKeyUp={input.onKey(false)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) connection.releaseRemoteInput();
      }}
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
      <TabActions active={visible}>
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
          {showStage && <span style={{ opacity: 0.45 }}>· {stage}</span>}
        </span>
        <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
        {/* Action group — operations on the live session. */}
        <button
          type="button"
          data-testid="rdp-reconnect"
          onClick={connection.reconnect}
          title={t("rdp.reconnect")}
          aria-label={t("rdp.reconnect")}
          style={FT_ICON_BUTTON_STYLE}
        >
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          data-testid="rdp-ctrl-alt-del"
          onClick={input.sendCtrlAltDel}
          disabled={status !== "connected"}
          title={t("rdp.ctrlAltDel")}
          aria-label={t("rdp.ctrlAltDel")}
          style={FT_BUTTON_STYLE}
        >
          Ctrl+Alt+Del
        </button>
        {chatToggle && (
          <button
            type="button"
            data-testid="rdp-chat-toggle"
            onClick={chatToggle.onToggle}
            title={chatToggle.open ? t("terminal.chatFloatingTitleClose") : t("terminal.chatFloatingTitleOpen")}
            aria-label={chatToggle.open ? t("terminal.chatFloatingLabelClose") : t("terminal.chatFloatingLabelOpen")}
            style={{
              ...FT_ICON_BUTTON_STYLE,
              ...(chatToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <Bot size={14} />
          </button>
        )}
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
        <span style={FT_SEPARATOR_STYLE} aria-hidden="true" />
        {/* View group — how the desktop is scaled and sized. The remote
            desktop auto-resizes to the viewport on its own (ResizeObserver
            below), so there is no manual resize button: scale toggle picks
            fit-vs-1:1, the view button toggles OS fullscreen. */}
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
          data-testid="rdp-view-cycle"
          onClick={cycleView}
          title={`${cycle.label}${cycle.hint}`}
          aria-label={cycle.label}
          style={FT_ICON_BUTTON_STYLE}
        >
          {cycle.icon}
        </button>
        {detachedWindowControls && (
          <>
            <ScreenshotMenuButton />
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
          </>
        )}
      </TabActions>

      {currentFullscreen && visible && status === "connected" && (
        <RdpConnectionBar
          title={conn?.serverName || host}
          network={network}
          revealSignal={barReveal}
          onCtrlAltDel={input.sendCtrlAltDel}
          onMinimize={minimizeWindow}
          onRestore={toggleOsFullscreen}
          onDisconnect={() => {
            connection.disconnectSession();
            toggleOsFullscreen();
          }}
        />
      )}

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
          // The connected handler owns framebuffer dimensions. React must not
          // assign them again after the first resized frame has been drawn:
          // even an identical canvas dimension assignment clears its pixels.
          width={1920}
          height={1080}
          onPointerMove={input.onPointer}
          onPointerDown={(e) => {
            imeInputRef.current?.focus({ preventScroll: true });
            input.onPointer(e);
          }}
          onPointerUp={input.onPointer}
          onPointerCancel={() => connection.releaseRemoteInput()}
          onWheel={input.onWheel}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            maxWidth: scaleMode === "fit" ? "100%" : undefined,
            maxHeight: scaleMode === "fit" ? "100%" : undefined,
            imageRendering: "pixelated",
            background: "#000",
            // IronRDP forwards the server-provided shape, while the WebView
            // moves this local cursor immediately without waiting for a remote
            // framebuffer update.
            cursor: status === "connected" ? remoteCursorCss : "default",
          }}
        />
        <textarea
          ref={imeInputRef}
          tabIndex={-1}
          aria-label={t("rdp.imeInput")}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onCompositionStart={() => {
            connection.composingRef.current = true;
          }}
          onCompositionEnd={input.onCompositionEnd}
          onInput={(e) => {
            if (!connection.composingRef.current) e.currentTarget.value = "";
          }}
          onPaste={(e) => e.preventDefault()}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
            insetInlineStart: 0,
            bottom: 0,
            padding: 0,
            border: 0,
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
  ));
}
