import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { formatUnknownError } from "../../lib/appDialogs";
import { SCROLL_PROGRESS_EVENT, scrollStatus, stopScrollCapture, setScrollMode, type ScrollMode, type ScrollStatus } from "../../lib/screenshot";

/** The fullscreen selection overlay is hidden while the underlying page scrolls. */
export function ScrollCaptureBar() {
  const t = useT();
  const [frames, setFrames] = useState(0);
  const [fullscreenSurface, setFullscreenSurface] = useState(false);
  useEffect(() => {
    let active = true;
    const elements = [document.documentElement, document.body];
    const backgrounds = elements.map((el) => el.style.background);
    void invoke<boolean>("screenshot_scroll_surface").then((value) => {
      if (!active) return;
      setFullscreenSurface(value);
      if (value) elements.forEach((el) => { el.style.background = "transparent"; });
    }).catch(() => undefined);
    return () => { active = false; elements.forEach((el, i) => { el.style.background = backgrounds[i]; }); };
  }, []);
  const [mode, setMode] = useState<ScrollMode>("auto");
  const [needsOverlap, setNeedsOverlap] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const update = (status: ScrollStatus) => {
      if (disposed) return;
      setFrames((n) => Math.max(n, status.frames));
      setMode(status.mode ?? "auto");
      setNeedsOverlap(status.needsOverlap ?? false);
      setInputError(status.inputError ?? null);
    };
    void listen<ScrollStatus>(SCROLL_PROGRESS_EVENT, ({ payload }) => {
      update(payload);
    }).then(async (fn) => {
      if (disposed) { fn(); return; }
      unlisten = fn;
      const status = await scrollStatus();
      if (status) update(status);
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
  const changeMode = async () => {
    if (changingMode || finishing) return;
    setChangingMode(true);
    setError(null);
    const next = mode === "auto" ? "manual" : "auto";
    try { await setScrollMode(next); setMode(next); }
    catch (e) { setError(formatUnknownError(e)); }
    finally { setChangingMode(false); }
  };
  return <div data-testid="screenshot-scroll-controller" className="fixed left-0 right-0 bottom-0 px-3 py-2 text-[12px] select-none overflow-auto"
    style={{ height: fullscreenSurface ? 200 : "100%", background: "var(--taomni-panel-bg)", color: "var(--taomni-text)", border: "1px solid var(--taomni-divider)" }}>
    <p data-testid="screenshot-scroll-progress" role="status" className="mb-1 font-medium">{t("screenshot.scrollProgress", { count: frames })}</p>
    <p data-testid="screenshot-scroll-mode-hint" className="text-[var(--taomni-text-muted)] mb-2">{t(finishing ? "screenshot.scrollFinishing" : needsOverlap ? "screenshot.scrollOverlapHint" : mode === "manual" ? "screenshot.scrollManualHint" : "screenshot.scrollRunningHint")}</p>
    <div className="flex justify-end gap-2">
      <button data-testid="screenshot-scroll-switch-mode" type="button" disabled={finishing || changingMode} onClick={() => void changeMode()} className="px-2 py-1 rounded disabled:opacity-40">{t(mode === "auto" ? "screenshot.scrollUseManual" : "screenshot.scrollUseAuto")}</button>
      <button data-testid="screenshot-scroll-cancel" type="button" disabled={finishing} onClick={() => void finish(true)} className="px-3 py-1 rounded disabled:opacity-40">{t("screenshot.cancel")}</button>
      <button data-testid="screenshot-scroll-stop" type="button" disabled={finishing} onClick={() => void finish(false)} className="px-3 py-1 rounded disabled:opacity-40"
        style={{ background: "var(--taomni-accent)", color: "#fff" }}>{t("screenshot.scrollFinish")}</button>
    </div>
    {(error || inputError) && <p data-testid="screenshot-scroll-error" style={{ color: "#ff6b6b" }}>{error ?? inputError}</p>}
  </div>;
}
