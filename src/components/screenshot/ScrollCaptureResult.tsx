import { useState } from "react";
import { useT } from "../../lib/i18n";

/** A captured document is an image, not a new desktop selection. */
export function ScrollCaptureResult({ url, width, height, frames, onEdit, onCopy, onSave, onPin, onClose }: {
  url: string; width: number; height: number; frames: number;
  onEdit: () => void; onCopy: () => void; onSave: () => void; onPin: () => void; onClose: () => void;
}) {
  const t = useT();
  const [actual, setActual] = useState(false);
  const button = "rounded-lg px-3 py-2 text-[13px] hover:bg-[var(--taomni-hover)]";
  return <section data-testid="screenshot-scroll-result" className="fixed inset-0 z-[70] flex flex-col"
    style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-[var(--taomni-divider)]">
      <div>
        <h2 className="text-[14px] font-medium">{t("screenshot.scrollResult")}</h2>
        <p data-testid="screenshot-scroll-result-meta" className="text-[12px] text-[var(--taomni-text-muted)]">{width} × {height} · {t("screenshot.scrollDone", { count: frames })}</p>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" data-testid="screenshot-scroll-fit" className={button} aria-pressed={!actual} onClick={() => setActual(false)}>{t("screenshot.fitImage")}</button>
        <button type="button" data-testid="screenshot-scroll-actual" className={button} aria-pressed={actual} onClick={() => setActual(true)}>{t("screenshot.actualImage")}</button>
      </div>
    </header>
    <div data-testid="screenshot-scroll-result-viewport" className="flex-1 min-h-0 overflow-auto p-4" style={{ background: "#202124" }}>
      <img data-testid="screenshot-scroll-result-image" src={url} alt={t("screenshot.scrollResult")} draggable={false}
        style={{ display: "block", margin: "0 auto", width: actual ? width : "auto", height: actual ? height : "auto",
          maxWidth: actual ? "none" : "100%", maxHeight: actual ? "none" : "100%", objectFit: "contain" }} />
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-[var(--taomni-divider)]">
      <button type="button" data-testid="screenshot-scroll-result-close" className={`${button} mr-auto`} onClick={onClose}>{t("screenshot.cancel")}</button>
      <button type="button" data-testid="screenshot-scroll-result-edit" className={button} onClick={onEdit}>{t("screenshot.annotateResult")}</button>
      <button type="button" data-testid="screenshot-scroll-result-pin" className={button} onClick={onPin}>{t("screenshot.pin")}</button>
      <button type="button" data-testid="screenshot-scroll-result-save" className={button} onClick={onSave}>{t("screenshot.save")}</button>
      <button type="button" data-testid="screenshot-scroll-result-copy" className={button} style={{ background: "var(--taomni-accent)", color: "#fff" }} onClick={onCopy}>{t("screenshot.copy")}</button>
    </footer>
  </section>;
}
