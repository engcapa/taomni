import { FolderOpen } from "lucide-react";
import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { useT } from "../../lib/i18n";

const POSITION_KEY = "taomni.sftp.floatingPosition";
const WIDTH = 38;
const HEIGHT = 32;
const INSET = 8;
type Position = { x: number; y: number };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function loadPosition(): Position {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
    if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) {
      return { x: clamp(value.x), y: clamp(value.y) };
    }
  } catch { /* A blocked or stale preference must not hide the entry. */ }
  return { x: 1, y: 0.75 };
}

/** A small entry inside the terminal; dragging never sends terminal input. */
export function SftpFloatingButton({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState(loadPosition);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const suppressClick = useRef(false);
  const dragRef = useRef<{
    id: number; x: number; y: number; position: Position; moved: boolean;
  } | null>(null);
  const positionRef = useRef(position);
  const availableWidth = Math.max(0, bounds.width - WIDTH - INSET * 2);
  const availableHeight = Math.max(0, bounds.height - HEIGHT - INSET * 2);

  useLayoutEffect(() => {
    const parent = buttonRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setBounds({ width: parent.clientWidth, height: parent.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  function finishDrag(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    suppressClick.current = cancelled || drag.moved;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      try { localStorage.setItem(POSITION_KEY, JSON.stringify(positionRef.current)); }
      catch { /* Keep the usable in-memory position when storage is unavailable. */ }
    }
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid="sftp-floating-button"
      data-dragging={dragging || undefined}
      aria-label={t("terminal.sftpFloatingOpen")}
      title={t("terminal.sftpFloatingDragHint")}
      className="absolute z-40 flex flex-col items-center justify-center rounded-md border shadow-sm opacity-65 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--taomni-accent)]"
      style={{
        width: WIDTH, height: HEIGHT,
        left: Math.min(INSET, Math.max(0, bounds.width - WIDTH)) + position.x * availableWidth,
        top: Math.min(INSET, Math.max(0, bounds.height - HEIGHT)) + position.y * availableHeight,
        background: "var(--taomni-chrome-bg)", color: "var(--taomni-text-muted)",
        borderColor: "var(--taomni-divider)", cursor: dragging ? "grabbing" : "grab",
        touchAction: "none", userSelect: "none",
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
        dragRef.current = {
          id: event.pointerId, x: event.clientX, y: event.clientY, position, moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 5) return;
        drag.moved = true;
        setDragging(true);
        const next = {
          x: clamp(drag.position.x + dx / (availableWidth || 1)),
          y: clamp(drag.position.y + dy / (availableHeight || 1)),
        };
        positionRef.current = next;
        setPosition(next);
      }}
      onPointerUp={(event) => finishDrag(event)}
      onPointerCancel={(event) => finishDrag(event, true)}
      onLostPointerCapture={(event) => finishDrag(event, true)}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => {
        event.stopPropagation();
        if (suppressClick.current && event.detail !== 0) {
          suppressClick.current = false;
          return;
        }
        onOpen();
      }}
    >
      <FolderOpen size={13} aria-hidden="true" />
      <span className="text-[9px] leading-3">SFTP</span>
    </button>
  );
}
