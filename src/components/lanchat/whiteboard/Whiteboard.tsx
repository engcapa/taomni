import { useEffect, useRef, useState } from "react";
import { Arrow, Ellipse, Group, Layer, Line, Rect, Stage, Text } from "react-konva";
import getStroke from "perfect-freehand";
import type Konva from "konva";

import { useLanWbStore, nextSeq, type WbElement } from "../../../stores/lanWbStore";
import { useLanChatStore } from "../../../stores/lanChatStore";

/** perfect-freehand outline → flat Konva points. */
function strokePoints(points: number[], size: number): number[] {
  const input: number[][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) input.push([points[i], points[i + 1]]);
  const outline = getStroke(input, { size: Math.max(2, size * 2), thinning: 0.6, smoothing: 0.5, streamline: 0.5 });
  return outline.flat();
}

function renderElement(el: WbElement) {
  switch (el.type) {
    case "pen":
      return (
        <Line
          key={el.id}
          points={strokePoints(el.points ?? [], el.strokeWidth)}
          closed
          fill={el.color}
          listening={false}
        />
      );
    case "rect":
      return (
        <Rect key={el.id} x={el.x} y={el.y} width={el.w} height={el.h} stroke={el.color} strokeWidth={el.strokeWidth} cornerRadius={4} />
      );
    case "ellipse":
      return (
        <Ellipse
          key={el.id}
          x={(el.x ?? 0) + (el.w ?? 0) / 2}
          y={(el.y ?? 0) + (el.h ?? 0) / 2}
          radiusX={Math.abs(el.w ?? 0) / 2}
          radiusY={Math.abs(el.h ?? 0) / 2}
          stroke={el.color}
          strokeWidth={el.strokeWidth}
        />
      );
    case "arrow":
      return (
        <Arrow key={el.id} points={[el.x ?? 0, el.y ?? 0, el.x2 ?? 0, el.y2 ?? 0]} stroke={el.color} fill={el.color} strokeWidth={el.strokeWidth} pointerLength={10} pointerWidth={10} />
      );
    case "text":
      return <Text key={el.id} x={el.x} y={el.y} text={el.text ?? ""} fontSize={16} fontStyle="600" fill={el.color} />;
    case "note":
      return (
        <Group key={el.id} x={el.x} y={el.y}>
          <Rect width={el.w ?? 160} height={el.h ?? 90} fill="#fde68a" cornerRadius={4} shadowBlur={4} shadowOpacity={0.2} />
          <Text x={10} y={10} width={(el.w ?? 160) - 20} text={el.text ?? ""} fontSize={12} fill="#78350f" />
        </Group>
      );
    default:
      return null;
  }
}

const COLORS = ["#1e40af", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#0f172a", "#ec4899"];

/** Cap how often an in-progress shape is written to the shared Yjs doc. A fast
 *  pointermove fires ~60×/s; throttling to this interval emits ~10 wb-ops/s to
 *  peers (with a guaranteed final write on pointer-up) instead of one per move. */
const WB_WRITE_MS = 90;

/** The geometry fields that change while a shape is being drawn. */
function geomPatch(el: WbElement): Partial<WbElement> {
  switch (el.type) {
    case "pen":
      return { points: el.points };
    case "arrow":
      return { x2: el.x2, y2: el.y2 };
    default:
      return { w: el.w, h: el.h };
  }
}

/** The collaborative canvas. Reads elements from the Yjs-backed store; drawing
 *  mutates the store (which broadcasts via the provider once a board is live). */
export function Whiteboard() {
  const elements = useLanWbStore((s) => s.elements);
  const tool = useLanWbStore((s) => s.tool);
  const color = useLanWbStore((s) => s.color);
  const strokeWidth = useLanWbStore((s) => s.strokeWidth);
  const cursors = useLanWbStore((s) => s.cursors);
  const setTool = useLanWbStore((s) => s.setTool);
  const setColor = useLanWbStore((s) => s.setColor);
  const addElement = useLanWbStore((s) => s.addElement);
  const updateElement = useLanWbStore((s) => s.updateElement);
  const deleteElement = useLanWbStore((s) => s.deleteElement);
  const undo = useLanWbStore((s) => s.undo);
  const redo = useLanWbStore((s) => s.redo);
  const clear = useLanWbStore((s) => s.clear);
  const provider = useLanWbStore((s) => s.provider);
  const myName = useLanChatStore((s) => s.profile?.name ?? "我");

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const cursorThrottle = useRef(0);

  // In-progress drawing: `live` is the source of truth (refreshed every move);
  // `preview` mirrors it for smooth local rendering. Writes to the shared Yjs
  // doc are throttled (WB_WRITE_MS) so peers get ~10 ops/s, not one per move.
  const live = useRef<WbElement | null>(null);
  const [preview, setPreview] = useState<WbElement | null>(null);
  const lastWrite = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Drop any pending throttled write if the canvas unmounts mid-stroke.
  useEffect(() => () => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
  }, []);

  const pos = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const p = e.target.getStage()?.getPointerPosition();
    return { x: p?.x ?? 0, y: p?.y ?? 0 };
  };

  /** Flush the live element's current geometry to the shared doc. */
  const writeLive = () => {
    const el = live.current;
    if (!el) return;
    lastWrite.current = Date.now();
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    updateElement(el.id, geomPatch(el));
  };

  const onDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const { x, y } = pos(e);
    const id = crypto.randomUUID();
    const base = { id, seq: nextSeq(), color, strokeWidth };
    let el: WbElement | null = null;
    if (tool === "pen") {
      el = { ...base, type: "pen", points: [x, y] };
    } else if (tool === "rect" || tool === "ellipse") {
      el = { ...base, type: tool, x, y, w: 0, h: 0 };
    } else if (tool === "arrow") {
      el = { ...base, type: "arrow", x, y, x2: x, y2: y };
    } else if (tool === "text") {
      const text = window.prompt("文字内容：", "");
      if (text) addElement({ ...base, type: "text", x, y, text });
      return;
    } else if (tool === "note") {
      addElement({ ...base, type: "note", x, y, w: 160, h: 90, text: "便签…" });
      return;
    }
    if (!el) return;
    addElement(el); // element exists in the doc from the first point
    live.current = el;
    setPreview(el);
    lastWrite.current = Date.now();
  };

  const onMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const { x, y } = pos(e);
    const now = Date.now();
    if (provider && now - cursorThrottle.current > 40) {
      cursorThrottle.current = now;
      provider.sendCursor(x, y, myName, color);
    }
    const cur = live.current;
    if (!cur) return;
    let next: WbElement;
    if (cur.type === "pen") {
      next = { ...cur, points: [...(cur.points ?? []), x, y] };
    } else if (cur.type === "arrow") {
      next = { ...cur, x2: x, y2: y };
    } else {
      next = { ...cur, w: x - (cur.x ?? 0), h: y - (cur.y ?? 0) };
    }
    live.current = next;
    setPreview(next); // smooth local render every move
    if (now - lastWrite.current >= WB_WRITE_MS) {
      writeLive();
    } else if (!flushTimer.current) {
      flushTimer.current = setTimeout(writeLive, WB_WRITE_MS - (now - lastWrite.current));
    }
  };

  const onUp = () => {
    if (live.current) writeLive(); // final authoritative write
    live.current = null;
    setPreview(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="flex w-[54px] flex-none flex-col items-center gap-1 pt-2" style={{ background: "var(--taomni-panel-bg)", borderRight: "1px solid var(--taomni-divider)" }}>
        {(["select", "pen", "rect", "ellipse", "arrow", "text", "note", "eraser"] as const).map((t) => (
          <button
            key={t}
            type="button"
            title={t}
            onClick={() => setTool(t)}
            className="grid h-9 w-9 place-items-center rounded-lg text-[11px]"
            style={{
              background: tool === t ? "var(--taomni-selected)" : "transparent",
              color: tool === t ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
              border: tool === t ? "1px solid var(--taomni-selected-border)" : "1px solid transparent",
            }}
          >
            {toolLabel(t)}
          </button>
        ))}
        <div className="mt-2 flex flex-col gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="h-5 w-5 rounded-full"
              style={{ background: c, boxShadow: color === c ? "0 0 0 2px var(--taomni-accent)" : "0 0 0 1px var(--taomni-divider)" }}
            />
          ))}
        </div>
      </div>

      <div
        ref={wrapRef}
        className="relative min-w-0 flex-1"
        style={{ background: "radial-gradient(circle, var(--taomni-divider) 1px, transparent 1px)", backgroundSize: "22px 22px", backgroundColor: "var(--taomni-card-bg)" }}
      >
        <div className="absolute left-1/2 top-2.5 z-10 flex -translate-x-1/2 gap-1.5 rounded-[10px] p-1.5" style={{ background: "var(--taomni-card-bg)", border: "1px solid var(--taomni-card-border)", boxShadow: "var(--taomni-shadow-lg)" }}>
          <button type="button" onClick={undo} className="rounded-md px-2.5 py-1 text-[12px]">↶ 撤销</button>
          <button type="button" onClick={redo} className="rounded-md px-2.5 py-1 text-[12px]">↷ 重做</button>
          <button type="button" onClick={() => { if (confirm("清空白板？")) clear(); }} className="rounded-md px-2.5 py-1 text-[12px]">🗑 清空</button>
        </div>
        <Stage
          width={size.w}
          height={size.h}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          style={{ cursor: tool === "select" ? "default" : "crosshair" }}
        >
          <Layer>
            {elements.map((el) =>
              el.id === preview?.id ? null : tool === "eraser" ? (
                <Group key={el.id} onClick={() => deleteElement(el.id)} onTap={() => deleteElement(el.id)}>
                  {renderElement(el)}
                </Group>
              ) : (
                renderElement(el)
              ),
            )}
            {/* In-progress stroke: rendered locally every move; the committed
                copy (throttled) is hidden above to avoid a double draw. */}
            {preview ? renderElement(preview) : null}
          </Layer>
        </Stage>
        {Object.entries(cursors).map(([id, c]) => (
          <div key={id} className="pointer-events-none absolute z-20" style={{ left: c.x, top: c.y, transition: "all .12s linear" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" style={{ fill: c.color, stroke: "#fff" }}>
              <path d="M3 3l7 17 2-7 7-2z" />
            </svg>
            <span className="ml-3 rounded px-1.5 text-[10px] text-white" style={{ background: c.color }}>{c.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function toolLabel(t: string): string {
  return { select: "⤢", pen: "✏", rect: "▭", ellipse: "◯", arrow: "↗", text: "T", note: "▤", eraser: "⌫" }[t] ?? t;
}
