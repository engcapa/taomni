import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useT } from "../../lib/i18n";
import { formatUnknownError } from "../../lib/appDialogs";
import { SCROLL_PROGRESS_EVENT, scrollStatus, stopScrollCapture, type ScrollStatus } from "../../lib/screenshot";

/** The fullscreen selection overlay is hidden while the underlying page scrolls. */
export function ScrollCaptureBar() {
  const t = useT();
  const [frames, setFrames] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ScrollStatus>(SCROLL_PROGRESS_EVENT, ({ payload }) => {
      if (!disposed) setFrames((n) => Math.max(n, payload.frames));
    }).then(async (fn) => {
      if (disposed) { fn(); return; }
      unlisten = fn;
      const status = await scrollStatus();
      if (!disposed && status) setFrames((n) => Math.max(n, status.frames));
    }).catch((e) => { if (!disposed) setError(formatUnknownError(e)); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const finish = async (cancel: boolean) => {
    if (finishing) return;
    setFinishing(true);
    setError(null);
    try { await stopScrollCapture(cancel); }
    catch (e) { setError(formatUnknownError(e)); setFinishing(false); }
  };
  return <div data-testid="screenshot-scroll-controller" className="fixed inset-0 px-3 py-2 text-[12px] select-none"
    style={{ background: "var(--taomni-panel-bg)", color: "var(--taomni-text)", border: "1px solid var(--taomni-divider)" }}>
    <p data-testid="screenshot-scroll-progress" role="status" className="mb-1 font-medium">{t("screenshot.scrollProgress", { count: frames })}</p>
    <p className="text-[var(--taomni-text-muted)] mb-2">{t(finishing ? "screenshot.scrollFinishing" : "screenshot.scrollRunningHint")}</p>
    <div className="flex justify-end gap-2">
      <button data-testid="screenshot-scroll-cancel" type="button" disabled={finishing} onClick={() => void finish(true)} className="px-3 py-1 rounded disabled:opacity-40">{t("screenshot.cancel")}</button>
      <button data-testid="screenshot-scroll-stop" type="button" disabled={finishing} onClick={() => void finish(false)} className="px-3 py-1 rounded disabled:opacity-40"
        style={{ background: "var(--taomni-accent)", color: "#fff" }}>{t("screenshot.scrollFinish")}</button>
    </div>
    {error && <p data-testid="screenshot-scroll-error" style={{ color: "#ff6b6b" }}>{error}</p>}
  </div>;
}
