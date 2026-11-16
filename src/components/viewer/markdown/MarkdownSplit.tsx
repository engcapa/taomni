import { useRef, useState, type ReactNode } from "react";
import { useViewerLabels } from "../viewerLabels";

/** A separator changes layout without reparenting either editor, so its view,
 * selection and history survive resizing and mode changes. */
export function MarkdownSplit({ children, className = "", enabled = true }: { children: ReactNode[]; className?: string; enabled?: boolean }) {
  const label = useViewerLabels();
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const [ratio, setRatio] = useState(50);
  const resize = (value: number) => setRatio(Math.min(80, Math.max(20, value)));
  return <div ref={root} className={`fv-md-resizable ${enabled ? "is-split" : ""} ${className}`} style={enabled ? { gridTemplateColumns: `minmax(0,${ratio}fr) 7px minmax(0,${100 - ratio}fr)` } : undefined}>
    {children[0]}
    <div role="separator" aria-label={label("调整源码与预览宽度", "Resize source and preview")} aria-orientation="vertical"
      aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(ratio)} tabIndex={enabled ? 0 : -1}
      hidden={!enabled} data-testid="markdown-split-resize" className="fv-md-resize-handle"
      onPointerDown={(event) => { if (event.button !== 0) return; drag.current = event.pointerId; event.currentTarget.setPointerCapture?.(event.pointerId); event.preventDefault(); }}
      onPointerMove={(event) => {
        if (drag.current !== event.pointerId) return;
        const rect = root.current?.getBoundingClientRect();
        if (rect?.width) resize((event.clientX - rect.left) / rect.width * 100);
      }}
      onPointerUp={(event) => { drag.current = null; if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => resize(50)} onKeyDown={(event) => {
        const value = event.key === "ArrowLeft" ? ratio - 5 : event.key === "ArrowRight" ? ratio + 5 : event.key === "Home" ? 20 : event.key === "End" ? 80 : null;
        if (value !== null) { event.preventDefault(); resize(value); }
      }} />
    {children[1]}
  </div>;
}
