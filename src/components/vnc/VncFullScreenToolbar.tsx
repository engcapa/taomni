import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize, Menu as MenuIcon, Minimize, Minimize2, Pin, PinOff, Power, ShieldAlert } from "lucide-react";
import { useT } from "../../lib/i18n";

/**
 * Delay before an unpinned toolbar slides away once the pointer is off both
 * the top edge and the toolbar. RealVNC Viewer starts hiding as soon as the
 * pointer leaves (measured 2026-10-01); the few milliseconds only bridge the
 * hand-over from the edge strip to the toolbar sliding in under the pointer.
 */
export const VNC_TOOLBAR_HIDE_MS = 50;
/** Slide in/out duration (RealVNC Viewer: ~0.25 s each way). */
const VNC_TOOLBAR_SLIDE_MS = 250;
/** Height of the top-edge strip that reveals the toolbar, in device pixels (RealVNC: rows 0-2). */
const VNC_TOOLBAR_EDGE_DEVICE_PX = 3;

export interface VncFullScreenToolbarProps {
  scaledTo100: boolean;
  viewOnly: boolean;
  onExitFullScreen: () => void;
  onToggleScale: () => void;
  onSendCtrlAltDel: () => void;
  onOpenMenu: (x: number, y: number) => void;
  onEndSession: () => void;
}

const ICON_BUTTON: React.CSSProperties = {
  width: 30,
  height: 30,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 4,
  border: "none",
  background: "transparent",
  color: "#eee",
  cursor: "pointer",
};

/**
 * RealVNC Viewer's full-screen toolbar: hidden until the pointer touches the
 * top edge of the screen, slides out at the top centre, hides again after the
 * pointer leaves unless pinned (VNC-VIEW-002).
 */
export function VncFullScreenToolbar(props: VncFullScreenToolbarProps) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [pinned, setPinned] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);
  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setShown(false);
    }, VNC_TOOLBAR_HIDE_MS);
  }, [cancelHide]);
  useEffect(() => cancelHide, [cancelHide]);

  const visible = shown || pinned;
  const button = (testId: string, label: string, icon: React.ReactNode, onClick: (event: React.MouseEvent<HTMLButtonElement>) => void) => (
    <button
      type="button"
      data-testid={testId}
      title={label}
      aria-label={label}
      style={ICON_BUTTON}
      className="hover:bg-white/15"
      onClick={onClick}
    >
      {icon}
    </button>
  );

  return (
    <>
      {/* Hot zone along the top edge; the toolbar itself sits above it. */}
      <div
        data-testid="vnc-fullscreen-hotzone"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: VNC_TOOLBAR_EDGE_DEVICE_PX / (window.devicePixelRatio || 1),
          zIndex: 8,
        }}
        onPointerEnter={() => {
          cancelHide();
          setShown(true);
        }}
        onPointerLeave={() => {
          // Leaving the edge without reaching the toolbar hides it too; the
          // toolbar's own pointerenter cancels this when the pointer moves onto it.
          if (!pinned) scheduleHide();
        }}
      />
      <div
        data-testid="vnc-fullscreen-toolbar"
        data-visible={visible ? "true" : "false"}
        role="toolbar"
        aria-label={t("vnc.fullScreenToolbar")}
        onPointerEnter={cancelHide}
        onPointerLeave={() => {
          if (!pinned) scheduleHide();
        }}
        style={{
          position: "absolute",
          top: 0,
          left: "50%",
          transform: `translate(-50%, ${visible ? "0" : "-100%"})`,
          transition: `transform ${VNC_TOOLBAR_SLIDE_MS}ms ease-out`,
          zIndex: 9,
          display: "flex",
          gap: 4,
          padding: "4px 8px",
          background: "rgba(30, 30, 46, 0.92)",
          borderRadius: "0 0 8px 8px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        }}
      >
        {button("vnc-fs-exit", t("vnc.exitFullScreen"), <Minimize2 size={16} />, props.onExitFullScreen)}
        {button(
          "vnc-fs-scale",
          props.scaledTo100 ? t("vnc.scaleAutomatically") : t("vnc.scaleTo100"),
          props.scaledTo100 ? <Minimize size={16} /> : <Maximize size={16} />,
          props.onToggleScale,
        )}
        {!props.viewOnly && button("vnc-fs-cad", t("vnc.sendCtrlAltDel"), <ShieldAlert size={16} />, props.onSendCtrlAltDel)}
        {button("vnc-fs-menu", t("vnc.sessionMenu"), <MenuIcon size={16} />, (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          props.onOpenMenu(rect.left, rect.bottom + 4);
        })}
        {button(
          "vnc-fs-pin",
          pinned ? t("vnc.unpinToolbar") : t("vnc.pinToolbar"),
          pinned ? <PinOff size={16} /> : <Pin size={16} />,
          () => setPinned((value) => !value),
        )}
        {button("vnc-fs-end", t("vnc.endSession"), <Power size={16} />, props.onEndSession)}
      </div>
    </>
  );
}
