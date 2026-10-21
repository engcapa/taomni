import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useT } from "../../../lib/i18n";
import { resolveChatDock } from "../../../lib/chat/chatDock";
import { useViewportSize } from "../../../hooks/useViewportSize";
import { notesThemeStyle } from "../../../lib/notes/notesTheme";
import { positionIcon } from "./presentation";

export interface UseChatDrawerDockContext {
  hideDrawer: () => void;
  drawerPosition: import("../../../stores/chatStore").ChatDrawerPosition;
  drawerPinned: boolean;
  setDrawerPinned: (pinned: boolean) => void;
  drawerOpen: boolean;
  dismissDrawer: () => void;
  drawerWidth: number;
  drawerHeight: number;
  setDrawerWidth: (w: number) => void;
  setDrawerHeight: (h: number) => void;
  t: ReturnType<typeof useT>;
  drawerFloatingOpacity: number;
  hubTab: import("../../../stores/taoHubStore").TaoHubTab;
  notesTheme: import("../../../stores/notesStore").NotesTheme;
}

export function useChatDrawerDock(context: UseChatDrawerDockContext) {
  const {
    hideDrawer,
    drawerPosition,
    drawerPinned,
    setDrawerPinned,
    drawerOpen,
    dismissDrawer,
    drawerWidth,
    drawerHeight,
    setDrawerWidth,
    setDrawerHeight,
    t,
    drawerFloatingOpacity,
    hubTab,
    notesTheme,
  } = context;
  const [showPositionMenu, setShowPositionMenu] = useState(false);
  const [showOpacityMenu, setShowOpacityMenu] = useState(false);
  const resizingRef = useRef(false);
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 });

  // Narrow windows keep the tab usable by hiding to the ribbon; medium widths
  // float the drawer instead of consuming layout width.
  useEffect(() => {
    const handle = () => {
      const w = window.innerWidth;
      if (w < 760) {
        hideDrawer();
      } else if (w < 1120 && (drawerPosition === "left" || drawerPosition === "right") && drawerPinned) {
        setDrawerPinned(false);
      }
    };
    window.addEventListener("resize", handle);
    handle();
    return () => window.removeEventListener("resize", handle);
  }, [drawerPinned, drawerPosition, hideDrawer, setDrawerPinned]);

  const isHorizontalDock = drawerPosition === "left" || drawerPosition === "right";
  const viewport = useViewportSize();
  const dockMode = resolveChatDock(drawerPosition, drawerPinned, viewport.width, viewport.height);
  const sideBySide = dockMode === "side-inline";
  const stackedInline = dockMode === "stacked-inline";
  const floating = dockMode === "floating";
  const pinnedActive = sideBySide || stackedInline;
  const topBottomFloating = floating && (drawerPosition === "top" || drawerPosition === "bottom");

  useEffect(() => {
    if (!drawerOpen || !floating) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest('[data-testid="ai-chat-drawer"]') ||
        target.closest('[data-testid="ai-chat-drawer-ribbon"]') ||
        target.closest('[data-testid="ai-chat-safety-gate"]') ||
        target.closest("[data-tao-floating-portal]")
      ) {
        return;
      }
      setShowPositionMenu(false);
      setShowOpacityMenu(false);
      dismissDrawer();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [dismissDrawer, drawerOpen, floating]);

  // Drag-to-resize the drawer.
  const handleResizeStart = (
    e: ReactPointerEvent<HTMLDivElement>,
    axis: "width" | "height",
    edge?: "left" | "right",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;
    resizeStartRef.current = { x: e.clientX, y: e.clientY, width: drawerWidth, height: drawerHeight };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = axis === "width" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Browser preview fallback.
    }
    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      if (axis === "width") {
        if (drawerPosition === "left") {
          setDrawerWidth(resizeStartRef.current.width + ev.clientX - resizeStartRef.current.x);
        } else if (drawerPosition === "right") {
          setDrawerWidth(resizeStartRef.current.width + resizeStartRef.current.x - ev.clientX);
        } else if (edge === "left") {
          setDrawerWidth(resizeStartRef.current.width + (resizeStartRef.current.x - ev.clientX) * 2);
        } else {
          setDrawerWidth(resizeStartRef.current.width + (ev.clientX - resizeStartRef.current.x) * 2);
        }
      } else if (drawerPosition === "top") {
        setDrawerHeight(resizeStartRef.current.height + ev.clientY - resizeStartRef.current.y);
      } else {
        setDrawerHeight(resizeStartRef.current.height + resizeStartRef.current.y - ev.clientY);
      }
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const positionLabel = t(`chat.drawerPosition_${drawerPosition}`);
  const PositionIcon = positionIcon(drawerPosition);
  const containerClass = [
    "ai-z-drawer",
    sideBySide ? "relative h-full shrink-0" : "",
    stackedInline ? "relative w-full shrink-0" : "",
    !sideBySide && !stackedInline ? "absolute shadow-2xl" : "",
    drawerPosition === "left" ? "order-first" : "",
    floating ? "rounded-md" : "",
  ].filter(Boolean).join(" ");
  // Stay mounted while hidden so tab switches do not remount the transcript.
  const containerStyle: CSSProperties = !drawerOpen
    ? { display: "none" }
    : sideBySide
      ? { width: drawerWidth }
      : stackedInline
        ? { height: drawerHeight, width: "100%" }
        : isHorizontalDock
          ? {
            width: drawerWidth,
            top: 0,
            bottom: 0,
            [drawerPosition]: 0,
          }
          : {
            width: drawerWidth,
            maxWidth: "calc(100% - 32px)",
            height: drawerHeight,
            left: "50%",
            transform: "translateX(-50%)",
            [drawerPosition]: 0,
          };
  if (drawerOpen && topBottomFloating) {
    containerStyle.opacity = drawerFloatingOpacity;
  }
  const themedContainerStyle: CSSProperties = drawerOpen && hubTab === "notes"
    ? { ...containerStyle, ...notesThemeStyle(notesTheme) }
    : containerStyle;
  const resizeHandleClass = isHorizontalDock
    ? `absolute ${drawerPosition === "left" ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2"} top-0 bottom-0 w-2 cursor-col-resize bg-transparent hover:bg-[var(--taomni-accent)]/35 transition-colors z-20`
    : `absolute left-0 right-0 ${drawerPosition === "top" ? "bottom-0 translate-y-1/2" : "top-0 -translate-y-1/2"} h-2 cursor-row-resize bg-transparent hover:bg-[var(--taomni-accent)]/35 transition-colors z-20`;
  const widthResizeHandleClass =
    "absolute top-0 bottom-0 w-2 cursor-col-resize bg-transparent hover:bg-[var(--taomni-accent)]/35 transition-colors z-20";
  const panelBorderClass = sideBySide
    ? drawerPosition === "left"
      ? "border-r"
      : "border-l"
    : stackedInline
      ? drawerPosition === "top"
        ? "border-b"
        : "border-t"
      : "border";
  return { containerClass, themedContainerStyle, resizeHandleClass, isHorizontalDock, handleResizeStart, widthResizeHandleClass, panelBorderClass, floating, setShowPositionMenu, positionLabel, PositionIcon, showPositionMenu, pinnedActive, topBottomFloating, setShowOpacityMenu, showOpacityMenu };
}
