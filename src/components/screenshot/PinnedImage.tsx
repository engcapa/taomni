import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, Download, Maximize2, Minimize2, MoreHorizontal, Star, X } from "lucide-react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import { formatUnknownError } from "../../lib/appDialogs";
import {
  addScreenshotFavorite, removeScreenshotFavorite, copyImageToClipboard, saveImageToFile,
  closePin, fetchPinInit, loadScreenshotUrl, revokeScreenshotUrl, type PinInit,
} from "../../lib/screenshot";

/** An independent reference image; view changes never alter the original PNG. */
export function PinnedImage() {
  const t = useT();
  const [init, setInit] = useState<PinInit | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [opacity, setOpacity] = useState(1);
  const [favoriteId, setFavoriteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const sizeBusy = useRef(false);
  const expandedSize = useRef<LogicalSize | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded: string | null = null;
    const backgrounds = [document.documentElement, document.body].map((el) => ({ el, value: el.style.background }));
    backgrounds.forEach(({ el }) => { el.style.background = "transparent"; });
    fetchPinInit().then(async (pin) => {
      const objectUrl = await loadScreenshotUrl(pin.path);
      loaded = objectUrl;
      if (cancelled) { revokeScreenshotUrl(objectUrl); return; }
      setInit(pin);
      setFavoriteId(pin.favoriteId ?? null);
      setUrl(objectUrl);
      const scale = window.devicePixelRatio || 1;
      setZoom(Math.min(window.innerWidth * scale / pin.width, window.innerHeight * scale / pin.height));
    }).catch((e) => { if (!cancelled) setError(`${t("screenshot.pinLoadFailed")}: ${formatUnknownError(e)}`); });
    return () => {
      cancelled = true;
      revokeScreenshotUrl(loaded);
      backgrounds.forEach(({ el, value }) => { el.style.background = value; });
    };
  }, [t]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const close = async () => {
    try { await closePin(getCurrentWindow().label); }
    catch { await getCurrentWindow().close().catch(() => undefined); }
  };

  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await work(); }
    catch (e) { setError(formatUnknownError(e)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const copy = () => run(async () => {
    if (!init) return;
    await copyImageToClipboard(init.path);
    setNotice(t("screenshot.copied"));
  });
  const save = () => run(async () => {
    if (!init) return;
    const { save: choosePath } = await import("@tauri-apps/plugin-dialog");
    const dest = await choosePath({ title: t("screenshot.save"), defaultPath: "Taomni-pin.png", filters: [{ name: "PNG", extensions: ["png"] }] });
    if (typeof dest !== "string" || !dest.trim()) return;
    await saveImageToFile(init.path, dest);
    setNotice(t("screenshot.saved"));
  });
  const favorite = () => run(async () => {
    if (!init) return;
    if (favoriteId) {
      await removeScreenshotFavorite(favoriteId);
      setFavoriteId(null);
      setNotice(t("screenshot.pinUnfavorited"));
    } else {
      const item = await addScreenshotFavorite(init.path);
      setFavoriteId(item.id);
      setNotice(t("screenshot.pinFavorited"));
    }
  });

  const resize = async (next: number) => {
    if (!init || collapsed || sizeBusy.current) return;
    sizeBusy.current = true;
    try {
      const scale = await getCurrentWindow().scaleFactor();
      const max = Math.min(4, (window.screen.availWidth || 1600) * scale / init.width, (window.screen.availHeight || 1000) * scale / init.height);
      const value = Math.max(Math.min(0.1, max), Math.min(next, max));
      await getCurrentWindow().setSize(new LogicalSize(Math.max(240, Math.round(init.width * value / scale)), Math.max(160, Math.round(init.height * value / scale))));
      setZoom(value);
    } catch (e) { setError(formatUnknownError(e)); }
    finally { sizeBusy.current = false; }
  };
  const collapse = async () => {
    if (sizeBusy.current) return;
    sizeBusy.current = true;
    try {
      const win = getCurrentWindow();
      if (collapsed) {
        await win.setSize(expandedSize.current ?? new LogicalSize(320, 240));
        await win.setResizable(true);
      } else {
        const size = await win.innerSize();
        const scale = await win.scaleFactor();
        expandedSize.current = new LogicalSize(size.width / scale, size.height / scale);
        await win.setSize(new LogicalSize(64, 64));
        await win.setResizable(false);
      }
      setCollapsed(!collapsed);
      setMenuOpen(false);
    } catch (e) { setError(formatUnknownError(e)); }
    finally { sizeBusy.current = false; }
  };

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable='true']")) return;
      const command = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") { if (menuOpen) setMenuOpen(false); else void close(); }
      else if (command && e.key.toLowerCase() === "w") { e.preventDefault(); void close(); }
      else if (command && e.key.toLowerCase() === "c") { e.preventDefault(); void copy(); }
      else if (command && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
      else if (command && e.key.toLowerCase() === "d") { e.preventDefault(); void favorite(); }
      else if (e.key === "+" || e.key === "=" || e.key === "-") {
        e.preventDefault();
        const direction = e.key === "-" ? -1 : 1;
        if (command) setOpacity((value) => Math.max(0.1, Math.min(1, value + direction * 0.1)));
        else void resize(zoom + direction * 0.1);
      } else if (e.key === "0") { setOpacity(1); void resize(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, [data-pin-controls]")) return;
    if (e.button === 1) { setOpacity(1); void resize(1); return; }
    if (e.button === 0 && e.detail === 1) {
      setMenuOpen(false);
      void getCurrentWindow().startDragging().catch((err) => setError(formatUnknownError(err)));
    }
  };

  const buttonClass = "w-7 h-7 flex items-center justify-center rounded hover:bg-white/20 disabled:opacity-40";
  if (!init || !url) return error ? <div role="alert" className="fixed inset-0 p-3 bg-black/80 text-white text-[12px]" onDoubleClick={() => void close()}>{error}</div> : null;

  return <div data-testid="screenshot-pin-window" data-collapsed={collapsed} className="fixed inset-0 select-none group" style={{ cursor: "move" }}
    onMouseDown={handleMouseDown}
    onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("[data-pin-controls]")) { if (collapsed || e.shiftKey) void collapse(); else void close(); } }}
    onContextMenu={(e) => { e.preventDefault(); if (collapsed) void collapse(); else setMenuOpen(true); }}
    onWheel={(e) => { if ((e.target as HTMLElement).closest("[data-pin-controls]")) return; if (e.deltaY === 0) return; if (e.ctrlKey || e.metaKey) setOpacity((value) => Math.max(0.1, Math.min(1, value + (e.deltaY < 0 ? 0.1 : -0.1)))); else void resize(zoom + (e.deltaY < 0 ? 0.1 : -0.1)); }}
    title={t("screenshot.pinHint")}>
    <div data-testid="screenshot-pin-surface" className="absolute inset-0 flex items-center justify-center" style={{ opacity: collapsed ? 1 : opacity, backgroundColor: "#e2e2e2", backgroundImage: "conic-gradient(#c4c4c4 25%, transparent 0 50%, #c4c4c4 0 75%, transparent 0)", backgroundSize: "16px 16px" }}>
      <img data-testid="screenshot-pin-image" src={url} alt={t("screenshot.pin")} className="max-w-full max-h-full block pointer-events-none object-contain" style={collapsed ? { width: "100%", height: "100%" } : { width: init.width * zoom / (window.devicePixelRatio || 1), height: init.height * zoom / (window.devicePixelRatio || 1) }} draggable={false} />
    </div>
    <div className="absolute inset-0 pointer-events-none" style={{ boxShadow: "inset 0 0 0 1px rgba(22,119,255,0.6)" }} />
    {collapsed ? <button data-pin-controls data-testid="screenshot-pin-expand" title={t("screenshot.pinExpand")} aria-label={t("screenshot.pinExpand")} onClick={() => void collapse()}
      className="absolute bottom-0 right-0 p-1 rounded-tl bg-black/75 text-white"><Maximize2 size={16} /></button> : <>
      <div data-pin-controls data-testid="screenshot-pin-toolbar" className="absolute top-1 right-1 flex gap-0.5 p-1 rounded-lg bg-black/80 text-white cursor-default">
        <button data-testid="screenshot-pin-copy" className={buttonClass} title={`${t("screenshot.copy")} (Ctrl/Cmd+C)`} aria-label={t("screenshot.copy")} disabled={busy} onClick={() => void copy()}><Copy size={15} /></button>
        <button data-testid="screenshot-pin-save" className={buttonClass} title={`${t("screenshot.save")} (Ctrl/Cmd+S)`} aria-label={t("screenshot.save")} disabled={busy} onClick={() => void save()}><Download size={15} /></button>
        <button data-testid="screenshot-pin-favorite" className={buttonClass} title={t(favoriteId ? "screenshot.pinUnfavorite" : "screenshot.pinFavorite")} aria-label={t(favoriteId ? "screenshot.pinUnfavorite" : "screenshot.pinFavorite")} aria-pressed={!!favoriteId} disabled={busy} onClick={() => void favorite()}><Star size={15} fill={favoriteId ? "#faad14" : "none"} color={favoriteId ? "#faad14" : "currentColor"} /></button>
        <button data-testid="screenshot-pin-collapse" className={buttonClass} title={t("screenshot.pinCollapse")} aria-label={t("screenshot.pinCollapse")} onClick={() => void collapse()}><Minimize2 size={15} /></button>
        <button data-testid="screenshot-pin-menu-toggle" className={buttonClass} title={t("screenshot.pinOptions")} aria-label={t("screenshot.pinOptions")} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={15} /></button>
        <button data-testid="screenshot-pin-close" className={buttonClass} title={t("screenshot.cancel")} aria-label={t("screenshot.cancel")} onClick={() => void close()}><X size={15} /></button>
      </div>
      {menuOpen && <div data-pin-controls data-testid="screenshot-pin-menu" className="absolute top-11 right-1 left-1 max-h-[calc(100%-48px)] overflow-auto rounded-lg p-3 bg-black/90 text-white text-[12px] cursor-default">
        <div className="flex items-center gap-2 mb-2">{t("screenshot.pinZoom")}
          <button data-testid="screenshot-pin-zoom-out" className={buttonClass} aria-label={t("screenshot.pinZoomOut")} onClick={() => void resize(zoom - 0.1)}>−</button>
          <span data-testid="screenshot-pin-zoom" className="min-w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button data-testid="screenshot-pin-zoom-in" className={buttonClass} aria-label={t("screenshot.pinZoomIn")} onClick={() => void resize(zoom + 0.1)}>+</button>
          <button data-testid="screenshot-pin-reset" className="ml-auto rounded px-2 py-1 bg-white/15" onClick={() => { setOpacity(1); void resize(1); }}>{t("screenshot.pinReset")}</button>
        </div>
        <label className="flex items-center gap-2 mb-3">{t("screenshot.pinOpacity")}
          <input data-testid="screenshot-pin-opacity" aria-label={t("screenshot.pinOpacity")} type="range" min={10} max={100} step={10} value={Math.round(opacity * 100)} onChange={(e) => setOpacity(Number(e.target.value) / 100)} className="min-w-0 flex-1" />
          <span className="tabular-nums">{Math.round(opacity * 100)}%</span>
        </label>
        <p data-testid="screenshot-pin-help" className="leading-relaxed text-white/75">{t("screenshot.pinHelp")}</p>
      </div>}
    </>}
    {(error || notice) && <p data-pin-controls data-testid="screenshot-pin-notice" role={error ? "alert" : "status"} className="absolute bottom-1 left-1 right-1 rounded bg-black/85 text-white text-[11px] p-2 cursor-default break-words">{error ?? notice}</p>}
  </div>;
}
