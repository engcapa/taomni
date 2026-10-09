import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const PADDING = 16;

export const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/** Keep annotations in original-image coordinates across fit, zoom and scroll. */
export function ScrollCaptureResult({ url, width, height, frames, toolbar, children, onCopy, onSave, onPin, onClose }: {
  url: string; width: number; height: number; frames: number;
  toolbar: ReactNode; children: ReactNode;
  onCopy: () => void; onSave: () => void; onPin: () => void; onClose: () => void;
}) {
  const t = useT();
  // `null` follows the viewport (fit); a number is a user-chosen zoom.
  const [zoom, setZoom] = useState<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(1);
  // Image point to keep under the cursor (viewport offset) after a zoom.
  const anchorRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = () => {
      setFitScale(Math.min(1, Math.max(1, viewport.clientWidth - 2 * PADDING) / width, Math.max(1, viewport.clientHeight - 2 * PADDING) / height));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [width, height]);
  const scale = zoom ?? fitScale;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  /** Zoom keeping the image point under (vx, vy) fixed; centre by default. */
  const zoomTo = (next: number | null, vx?: number, vy?: number) => {
    const viewport = viewportRef.current;
    if (viewport && next !== null) {
      const ax = vx ?? viewport.clientWidth / 2;
      const ay = vy ?? viewport.clientHeight / 2;
      const current = scaleRef.current;
      const content = viewport.firstElementChild as HTMLElement | null;
      const left = (content?.offsetLeft ?? PADDING);
      const top = (content?.offsetTop ?? PADDING);
      anchorRef.current = {
        x: (viewport.scrollLeft + ax - left) / current,
        y: (viewport.scrollTop + ay - top) / current,
        vx: ax,
        vy: ay,
      };
    } else {
      anchorRef.current = null;
    }
    setZoom(next === null ? null : clampZoom(next));
  };
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!viewport) return;
    if (!anchor) {
      if (zoom === null) {
        viewport.scrollTop = 0;
        viewport.scrollLeft = 0;
      }
      return;
    }
    const content = viewport.firstElementChild as HTMLElement | null;
    viewport.scrollLeft = (content?.offsetLeft ?? PADDING) + anchor.x * scale - anchor.vx;
    viewport.scrollTop = (content?.offsetTop ?? PADDING) + anchor.y * scale - anchor.vy;
  }, [zoom, scale]);

  // Ctrl/Cmd + wheel zooms around the cursor; a plain wheel keeps scrolling.
  // React registers wheel listeners as passive, so attach one directly.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      const factor = Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.0025);
      zoomToRef.current(scaleRef.current * factor, e.clientX - r.left, e.clientY - r.top);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  // Middle-button drag pans the image at any zoom.
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 1 || !viewportRef.current) return;
    e.preventDefault();
    pan.current = { x: e.clientX, y: e.clientY, left: viewportRef.current.scrollLeft, top: viewportRef.current.scrollTop };
    const move = (ev: MouseEvent) => {
      const viewport = viewportRef.current;
      if (!viewport || !pan.current) return;
      viewport.scrollLeft = pan.current.left - (ev.clientX - pan.current.x);
      viewport.scrollTop = pan.current.top - (ev.clientY - pan.current.y);
    };
    const up = () => {
      pan.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomTo(scale * 1.25); }
    else if (e.key === "-") { e.preventDefault(); zoomTo(scale / 1.25); }
    else if (e.key === "0") { e.preventDefault(); zoomTo(1); }
  };

  const percent = Math.round(scale * 100);
  const button = "rounded-lg px-3 py-2 text-[13px] hover:bg-[var(--taomni-hover)]";
  return <section data-testid="screenshot-scroll-result" className="fixed inset-0 z-[70] flex flex-col"
    style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-[var(--taomni-divider)]">
      <div>
        <h2 className="text-[14px] font-medium">{t(frames > 0 ? "screenshot.scrollResult" : "screenshot.editImage")}</h2>
        <p data-testid="screenshot-scroll-result-meta" className="text-[12px] text-[var(--taomni-text-muted)]">{width} × {height}{frames > 0 ? ` · ${t("screenshot.scrollDone", { count: frames })}` : ""}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" data-testid="screenshot-scroll-zoom-out" className={button} title={t("screenshot.zoomOut")} aria-label={t("screenshot.zoomOut")} onClick={() => zoomTo(scale / 1.25)}>−</button>
        <input type="range" data-testid="screenshot-scroll-zoom" aria-label={t("screenshot.zoom")} title={t("screenshot.zoomHint")}
          min={Math.round(MIN_ZOOM * 100)} max={Math.round(MAX_ZOOM * 100)} step={1} value={percent}
          onChange={(e) => zoomTo(Number(e.target.value) / 100)} className="w-32 sm:w-40" />
        <button type="button" data-testid="screenshot-scroll-zoom-in" className={button} title={t("screenshot.zoomIn")} aria-label={t("screenshot.zoomIn")} onClick={() => zoomTo(scale * 1.25)}>+</button>
        <span data-testid="screenshot-scroll-zoom-value" className="w-12 text-right text-[12px] tabular-nums text-[var(--taomni-text-muted)]" aria-live="polite">{percent}%</span>
        <button type="button" data-testid="screenshot-scroll-fit" className={button} aria-pressed={zoom === null} onClick={() => zoomTo(null)}>{t("screenshot.fitImage")}</button>
        <button type="button" data-testid="screenshot-scroll-actual" className={button} aria-pressed={zoom === 1} onClick={() => zoomTo(1)}>{t("screenshot.actualImage")}</button>
      </div>
    </header>
    {toolbar}
    <div ref={viewportRef} tabIndex={0} aria-label={t("screenshot.scrollResult")} id="screenshot-scroll-result-viewport" data-testid="screenshot-scroll-result-viewport" className="relative flex-1 min-h-0 overflow-auto"
      style={{ background: "#202124", padding: PADDING }} onMouseDown={onMouseDown} onKeyDown={onKeyDown}>
      <div style={{ position: "relative", width: width * scale, height: height * scale, margin: "0 auto", overflow: "hidden" }}>
        <div style={{ position: "relative", width, height, transform: `scale(${scale})`, transformOrigin: "top left" }}>
          <img data-testid="screenshot-scroll-result-image" src={url} alt={t("screenshot.scrollResult")} draggable={false}
            style={{ display: "block", width, height, maxWidth: "none", pointerEvents: "none" }} />
          {children}
        </div>
      </div>
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-[var(--taomni-divider)]">
      <button type="button" data-testid="screenshot-scroll-result-close" className={`${button} mr-auto`} onClick={onClose}>{t("screenshot.cancel")} (Esc)</button>
      <button type="button" data-testid="screenshot-scroll-result-pin" className={button} onClick={onPin}>{t("screenshot.pin")}</button>
      <button type="button" data-testid="screenshot-scroll-result-save" className={button} onClick={onSave}>{t("screenshot.save")}</button>
      <button type="button" data-testid="screenshot-scroll-result-copy" title={t("screenshot.copy")} className={button} style={{ background: "var(--taomni-accent)", color: "#fff" }} onClick={onCopy}>{t("screenshot.done")}</button>
    </footer>
  </section>;
}
