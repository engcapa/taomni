// FloatingToolbar — draggable, collapsible wrapper for tab-overlay toolbars
// (CaptureToolbar, SFTP toggle, VNC scaling button, etc).
//
// The toolbar floats absolutely inside its closest positioned ancestor. The
// caller is responsible for making that ancestor `position: relative`. Users
// can:
//   * drag the grip handle to move the toolbar anywhere within its parent
//   * click the collapse button to either shrink to a small restore pill
//     OR dock to any edge as a slim drawer pull (chevron sliver)
//   * the position, dock edge, and collapsed state persist to localStorage
//     by `storageKey`
//
// When collapsed the pill is itself draggable so it never gets stuck behind
// content the user wants to read. Dragging the pill near a window edge
// (within 24 px) pins it to that edge as a drawer-pull tab; dragging back
// from the edge releases it back into the floating pill state.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  EyeOff,
  GripVertical,
} from "lucide-react";
import { useT } from "../../lib/i18n";

type DockEdge = "top" | "right" | "bottom" | "left";

interface StoredState {
  top: number;
  right: number;
  collapsed: boolean;
  dockEdge?: DockEdge | null;
}

export interface FloatingToolbarProps {
  /** Required. localStorage key used to persist position + collapsed state. */
  storageKey: string;
  /** Default placement when nothing is stored. Distance in px from the
   *  parent's top/right edges. */
  defaultTop?: number;
  defaultRight?: number;
  /** Tooltip on the collapse button. */
  collapseLabel?: string;
  /** Tooltip on the restore pill. */
  restoreLabel?: string;
  /** Optional test id forwarded to the outer container. */
  testId?: string;
  children: ReactNode;
}

const DEFAULT_TOP = 4;
const DEFAULT_RIGHT = 4;
/** Within this many CSS pixels of an edge, a drag snaps the pill into a
 *  drawer-pull tab on that edge. */
const EDGE_SNAP_PX = 24;

function readStored(key: string): Partial<StoredState> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: StoredState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota/serialization errors
  }
}

const HANDLE_BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: "#bbb",
  cursor: "grab",
  padding: 2,
  borderRadius: 3,
};

const ICON_BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: "#bbb",
  cursor: "pointer",
  padding: 2,
  borderRadius: 3,
};

const RESTORE_PILL_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.45)",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#ccc",
  borderRadius: 999,
  width: 22,
  height: 22,
  padding: 0,
  cursor: "pointer",
};

function dockChevron(edge: DockEdge): ReactNode {
  // Chevron points *away* from the edge so it visually invites a click
  // that pulls the toolbar back into view.
  switch (edge) {
    case "top":
      return <ChevronDown size={14} />;
    case "bottom":
      return <ChevronUp size={14} />;
    case "left":
      return <ChevronRight size={14} />;
    case "right":
    default:
      return <ChevronLeft size={14} />;
  }
}

function dockedTabStyle(edge: DockEdge): React.CSSProperties {
  const base: React.CSSProperties = {
    position: "absolute",
    background: "rgba(0,0,0,0.55)",
    border: "1px solid rgba(255,255,255,0.18)",
    color: "#ddd",
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backdropFilter: "blur(2px)",
    zIndex: 50,
  };
  switch (edge) {
    case "top":
      return {
        ...base,
        top: 0,
        left: "50%",
        transform: "translateX(-50%)",
        height: 14,
        width: 36,
        borderTop: "none",
        borderTopLeftRadius: 0,
        borderTopRightRadius: 0,
        borderBottomLeftRadius: 8,
        borderBottomRightRadius: 8,
      };
    case "bottom":
      return {
        ...base,
        bottom: 0,
        left: "50%",
        transform: "translateX(-50%)",
        height: 14,
        width: 36,
        borderBottom: "none",
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
      };
    case "left":
      return {
        ...base,
        left: 0,
        top: "50%",
        transform: "translateY(-50%)",
        width: 14,
        height: 36,
        borderLeft: "none",
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
        borderTopRightRadius: 8,
        borderBottomRightRadius: 8,
      };
    case "right":
    default:
      return {
        ...base,
        right: 0,
        top: "50%",
        transform: "translateY(-50%)",
        width: 14,
        height: 36,
        borderRight: "none",
        borderTopLeftRadius: 8,
        borderBottomLeftRadius: 8,
        borderTopRightRadius: 0,
        borderBottomRightRadius: 0,
      };
  }
}

export function FloatingToolbar({
  storageKey,
  defaultTop = DEFAULT_TOP,
  defaultRight = DEFAULT_RIGHT,
  collapseLabel,
  restoreLabel,
  testId,
  children,
}: FloatingToolbarProps) {
  const t = useT();
  const collapseLabelResolved = collapseLabel ?? t("floatingToolbar.hideTitle");
  const restoreLabelResolved = restoreLabel ?? t("floatingToolbar.showTitle");
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [position, setPosition] = useState<{ top: number; right: number }>(() => {
    const stored = readStored(storageKey);
    return {
      top: typeof stored?.top === "number" ? stored.top : defaultTop,
      right: typeof stored?.right === "number" ? stored.right : defaultRight,
    };
  });
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = readStored(storageKey);
    return typeof stored?.collapsed === "boolean" ? stored.collapsed : false;
  });
  const [dockEdge, setDockEdge] = useState<DockEdge | null>(() => {
    const stored = readStored(storageKey);
    const edge = stored?.dockEdge;
    return edge === "top" || edge === "right" || edge === "bottom" || edge === "left"
      ? edge
      : null;
  });

  // Persist whenever state changes.
  useEffect(() => {
    writeStored(storageKey, {
      top: position.top,
      right: position.right,
      collapsed,
      dockEdge,
    });
  }, [storageKey, position.top, position.right, collapsed, dockEdge]);

  // Re-clamp position into the parent rect after layout (covers parent
  // shrink, e.g. the user closed the sidebar and the panel got narrower).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    let { top, right } = position;
    const maxTop = Math.max(0, parentRect.height - rect.height);
    const maxRight = Math.max(0, parentRect.width - rect.width);
    let next = position;
    if (top < 0) next = { ...next, top: 0 };
    else if (top > maxTop) next = { ...next, top: maxTop };
    if (right < 0) next = { ...next, right: 0 };
    else if (right > maxRight) next = { ...next, right: maxRight };
    if (next !== position) setPosition(next);
  }, [position, collapsed]);

  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startTop: number;
    startRight: number;
    moved: boolean;
  } | null>(null);

  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const el = containerRef.current;
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      // Releasing edge dock when the user starts a drag turns the toolbar
      // back into a normal floating pill so they can re-position freely.
      if (dockEdge !== null) {
        setDockEdge(null);
      }
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTop: position.top,
        startRight: position.right,
        moved: false,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    },
    [position.top, position.right, dockEdge],
  );

  const handleDragMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const el = containerRef.current;
      if (!el) return;
      const parent = el.offsetParent as HTMLElement | null;
      const parentRect = parent ? parent.getBoundingClientRect() : null;
      const rect = el.getBoundingClientRect();
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      let nextTop = drag.startTop + dy;
      let nextRight = drag.startRight - dx;
      if (parentRect) {
        const maxTop = Math.max(0, parentRect.height - rect.height);
        const maxRight = Math.max(0, parentRect.width - rect.width);
        nextTop = Math.min(Math.max(0, nextTop), maxTop);
        nextRight = Math.min(Math.max(0, nextRight), maxRight);
      } else {
        nextTop = Math.max(0, nextTop);
        nextRight = Math.max(0, nextRight);
      }
      setPosition({ top: nextTop, right: nextRight });
    },
    [],
  );

  const handleDragEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragStateRef.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      // Edge-snap: if the user dropped the collapsed pill near an edge,
      // pin it as a docked drawer-pull. Only consider snapping when the
      // toolbar is in collapsed state — full toolbars stay free-floating.
      if (!collapsed || !drag.moved) return;
      const el = containerRef.current;
      const parent = el?.offsetParent as HTMLElement | null;
      const parentRect = parent ? parent.getBoundingClientRect() : null;
      if (!el || !parentRect) return;
      const rect = el.getBoundingClientRect();
      const distTop = rect.top - parentRect.top;
      const distLeft = rect.left - parentRect.left;
      const distRight = parentRect.right - rect.right;
      const distBottom = parentRect.bottom - rect.bottom;
      const minDist = Math.min(distTop, distLeft, distRight, distBottom);
      if (minDist > EDGE_SNAP_PX) return;
      let edge: DockEdge = "right";
      if (minDist === distTop) edge = "top";
      else if (minDist === distLeft) edge = "left";
      else if (minDist === distBottom) edge = "bottom";
      else edge = "right";
      setDockEdge(edge);
    },
    [collapsed],
  );

  if (collapsed && dockEdge) {
    // Drawer-pull: a slim sliver pinned to the chosen edge that restores
    // the toolbar in-place. The user can also long-press / drag it back
    // into the parent area, which clears `dockEdge` (handled by
    // `handleDragStart`).
    return (
      <button
        ref={containerRef as unknown as React.MutableRefObject<HTMLButtonElement>}
        type="button"
        data-testid={testId}
        aria-label={restoreLabelResolved}
        title={restoreLabelResolved}
        onClick={() => {
          // Single click → restore the toolbar fully.
          setDockEdge(null);
          setCollapsed(false);
        }}
        style={dockedTabStyle(dockEdge)}
      >
        {dockChevron(dockEdge)}
      </button>
    );
  }

  if (collapsed) {
    return (
      <div
        ref={containerRef}
        data-testid={testId}
        className="pointer-events-auto"
        style={{
          position: "absolute",
          top: position.top,
          right: position.right,
          zIndex: 50,
          display: "flex",
          alignItems: "center",
          gap: 2,
        }}
      >
        <button
          type="button"
          aria-label={t("floatingToolbar.dragLabel")}
          title={t("floatingToolbar.drag")}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          style={{ ...HANDLE_BUTTON_STYLE, opacity: 0.55 }}
        >
          <GripVertical size={12} />
        </button>
        <button
          type="button"
          aria-label={restoreLabelResolved}
          title={restoreLabelResolved}
          onClick={() => setCollapsed(false)}
          style={RESTORE_PILL_STYLE}
        >
          <ChevronRight size={14} />
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      className="pointer-events-auto"
      style={{
        position: "absolute",
        top: position.top,
        right: position.right,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 4,
        background: "rgba(20,20,28,0.55)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 6,
        padding: "2px 4px",
        backdropFilter: "blur(2px)",
      }}
    >
      <button
        type="button"
        aria-label={t("floatingToolbar.dragLabel")}
        title={t("floatingToolbar.dragLabel")}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        style={HANDLE_BUTTON_STYLE}
      >
        <GripVertical size={14} />
      </button>
      {children}
      <button
        type="button"
        aria-label={collapseLabelResolved}
        title={collapseLabelResolved}
        onClick={() => setCollapsed(true)}
        style={ICON_BUTTON_STYLE}
      >
        <EyeOff size={13} />
      </button>
    </div>
  );
}

export default FloatingToolbar;
