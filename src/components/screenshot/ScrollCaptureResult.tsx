import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

/** Keep annotations in original-image coordinates across fit, zoom and scroll. */
export function ScrollCaptureResult({ url, width, height, frames, toolbar, children, onCopy, onSave, onPin, onClose }: {
  url: string; width: number; height: number; frames: number;
  toolbar: ReactNode; children: ReactNode;
  onCopy: () => void; onSave: () => void; onPin: () => void; onClose: () => void;
}) {
  const t = useT();
  const [actual, setActual] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(1);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const resize = () => {
      setFitScale(Math.min(1, Math.max(1, viewport.clientWidth - 32) / width, Math.max(1, viewport.clientHeight - 32) / height));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [width, height]);
  const scale = actual ? 1 : fitScale;
  const zoom = (value: boolean) => {
    setActual(value);
    if (viewportRef.current) {
      viewportRef.current.scrollTop = 0;
      viewportRef.current.scrollLeft = 0;
    }
  };
  const button = "rounded-lg px-3 py-2 text-[13px] hover:bg-[var(--taomni-hover)]";
  return <section data-testid="screenshot-scroll-result" className="fixed inset-0 z-[70] flex flex-col"
    style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-[var(--taomni-divider)]">
      <div>
        <h2 className="text-[14px] font-medium">{t("screenshot.scrollResult")}</h2>
        <p data-testid="screenshot-scroll-result-meta" className="text-[12px] text-[var(--taomni-text-muted)]">{width} × {height} · {t("screenshot.scrollDone", { count: frames })}</p>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" data-testid="screenshot-scroll-fit" className={button} aria-pressed={!actual} onClick={() => zoom(false)}>{t("screenshot.fitImage")}</button>
        <button type="button" data-testid="screenshot-scroll-actual" className={button} aria-pressed={actual} onClick={() => zoom(true)}>{t("screenshot.actualImage")}</button>
      </div>
    </header>
    {toolbar}
    <div ref={viewportRef} tabIndex={0} aria-label={t("screenshot.scrollResult")} data-testid="screenshot-scroll-result-viewport" className="flex-1 min-h-0 overflow-auto p-4" style={{ background: "#202124" }}>
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
