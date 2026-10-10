import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, Download, Maximize2, Minimize2, MoreHorizontal, Star, X } from "lucide-react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { emitTo, listen } from "@tauri-apps/api/event";
import { useT } from "../../lib/i18n";
import { formatUnknownError } from "../../lib/appDialogs";
import {
  addScreenshotFavorite, removeScreenshotFavorite, copyImageToClipboard, saveImageToFile,
  closePin, fetchPinInit, loadScreenshotUrl, revokeScreenshotUrl, type PinInit,
  setPinCompact, setPinNote, arrangePins, pinsBatch, focusPin, openImageEditor, openPinEditor,
  openPinTools, closePinTools, PIN_ACTION_EVENT, PIN_UPDATED_EVENT, PIN_TOOL_EVENT, PIN_VIEW_EVENT, type PinView, type PinInit as UpdatedPin,
  type PinBatchAction, type PinArrangement,
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
  const [note, setNote] = useState("");
  const busyRef = useRef(false);
  const sizeBusy = useRef(false);
  const expandedSize = useRef<LogicalSize | null>(null);
  const toolsLabel = useRef<string | null>(null);
  const viewSnapshot = (): PinView => ({ zoom, opacity, note, busy, error, notice });
  const publishView = () => { if (toolsLabel.current) void emitTo(toolsLabel.current, PIN_VIEW_EVENT, viewSnapshot()).catch(() => undefined); };
  const hideTools = () => { setMenuOpen(false); void closePinTools().catch((e) => setError(formatUnknownError(e))); };

  useEffect(() => {
    let cancelled = false;
    let loaded: string | null = null;
    let generation = 0;
    let unlisten: (() => void) | undefined;
    const backgrounds = [document.documentElement, document.body].map((el) => ({ el, value: el.style.background }));
    backgrounds.forEach(({ el }) => { el.style.background = "transparent"; });
    const applyPin = async (pin: PinInit) => {
      const ticket = ++generation;
      const objectUrl = await loadScreenshotUrl(pin.path);
      if (cancelled || ticket !== generation) { revokeScreenshotUrl(objectUrl); return; }
      revokeScreenshotUrl(loaded);
      loaded = objectUrl;
      setInit(pin);
      setNote(pin.note ?? "");
      setFavoriteId(pin.favoriteId ?? null);
      setUrl(objectUrl);
      const scale = window.devicePixelRatio || 1;
      setZoom(Math.min(window.innerWidth * scale / pin.width, window.innerHeight * scale / pin.height));
    };
    void listen<UpdatedPin>(PIN_UPDATED_EVENT, ({ payload }) => {
      void applyPin(payload).catch((e) => { if (!cancelled) setError(formatUnknownError(e)); });
    }).then(async (off) => {
      if (cancelled) { off(); return; }
      unlisten = off;
      // A newer update must not be replaced by a slow initial payload.
      const initialGeneration = generation;
      const pin = await fetchPinInit();
      if (!cancelled && initialGeneration === generation) await applyPin(pin);
    }).catch((e) => { if (!cancelled) setError(`${t("screenshot.pinLoadFailed")}: ${formatUnknownError(e)}`); });
    return () => {
      cancelled = true;
      unlisten?.();
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
  const collapse = async (target = !collapsed) => {
    if (sizeBusy.current || target === collapsed) return;
    sizeBusy.current = true;
    setError(null);
    try {
      const win = getCurrentWindow();
      if (collapsed) {
        await win.setResizable(true);
        await setPinCompact(false);
        await win.setSize(expandedSize.current ?? new LogicalSize(320, 240));
      } else {
        const size = await win.innerSize();
        const scale = await win.scaleFactor();
        expandedSize.current = new LogicalSize(size.width / scale, size.height / scale);
        await setPinCompact(true);
        await win.setSize(new LogicalSize(64, 64));
        await win.setResizable(false);
      }
      setCollapsed(target);
      hideTools();
    } catch (e) { setError(formatUnknownError(e)); }
    finally { sizeBusy.current = false; }
  };

  const eventHandler = useRef<(action: string) => void>(() => undefined);
  eventHandler.current = (action) => {
    if (action === "collapse") void collapse(true);
    if (action === "expand") void collapse(false);
    if (action === "resetOpacity") setOpacity(1);
    if (action === "arranged" && init && !collapsed) {
      setZoom(Math.min(window.innerWidth * (window.devicePixelRatio || 1) / init.width, window.innerHeight * (window.devicePixelRatio || 1) / init.height));
    }
  };
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ action: string }>(PIN_ACTION_EVENT, ({ payload }) => eventHandler.current(payload.action)).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch((e) => { if (!disposed) setError(formatUnknownError(e)); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const editExternal = (choose: boolean) => run(async () => {
    if (!init) return;
    let editor: string | undefined;
    if (choose) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const value = await open({ title: t("screenshot.chooseEditor"), multiple: false });
      if (typeof value !== "string") return;
      editor = value;
    }
    await openImageEditor(init.path, editor);
  });

  const toolHandler = useRef<(request: { action: string; value?: unknown }) => void>(() => undefined);
  toolHandler.current = ({ action, value }) => {
    if (action === "sync") publishView();
    else if (action === "toolsClosed") { setMenuOpen(false); toolsLabel.current = null; }
    else if (action === "zoom" && typeof value === "number") void resize(value);
    else if (action === "opacity" && typeof value === "number") setOpacity(Math.max(0.1, Math.min(1, value)));
    else if (action === "note" && typeof value === "string") void run(async () => {
      setNote(await setPinNote(value)); setNotice(t("screenshot.saved"));
    });
    else if (action === "edit") void run(async () => { await openPinEditor(); hideTools(); });
    else if (action === "external") void editExternal(value === true);
    else if (action === "arrange" && ["tile", "cascade", "stackRight", "stackBottom"].includes(String(value))) void run(async () => { await arrangePins(value as PinArrangement); });
    else if (action === "batch" && ["collapse", "expand", "resetOpacity", "closeAll"].includes(String(value))) void run(async () => { await pinsBatch(value as PinBatchAction); });
    else if (action === "focus" && typeof value === "string") void run(() => focusPin(value));
  };
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listen<{ action: string; value?: unknown }>(PIN_TOOL_EVENT, ({ payload }) => toolHandler.current(payload)).then((fn) => { if (disposed) fn(); else off = fn; }).catch((e) => { if (!disposed) setError(formatUnknownError(e)); });
    return () => { disposed = true; off?.(); };
  }, []);
  useEffect(() => { publishView(); }, [zoom, opacity, note, busy, error, notice, menuOpen]);

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable='true']")) return;
      const command = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") { if (menuOpen) hideTools(); else void close(); }
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
      hideTools();
      void getCurrentWindow().startDragging().catch((err) => setError(formatUnknownError(err)));
    }
  };

  const buttonClass = "w-8 h-8 flex items-center justify-center rounded hover:bg-white/20 disabled:opacity-40";
  const openMenu = () => {
    toolsLabel.current = `screenshot-tools-${getCurrentWindow().label}`;
    void openPinTools(viewSnapshot()).then(() => setMenuOpen(true)).catch((e) => setError(formatUnknownError(e)));
  };
  if (!init || !url) return error ? <div role="alert" className="fixed inset-0 p-3 bg-black/80 text-white text-[12px]" onDoubleClick={() => void close()}>{error}</div> : null;

  return <div data-testid="screenshot-pin-window" data-collapsed={collapsed} className="fixed inset-0 select-none group" style={{ cursor: "move" }}
    onMouseDown={handleMouseDown}
    onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest("[data-pin-controls]")) { if (collapsed || e.shiftKey) void collapse(); else void close(); } }}
    onContextMenu={(e) => { e.preventDefault(); if (collapsed) void collapse(); else openMenu(); }}
    onWheel={(e) => { if ((e.target as HTMLElement).closest("[data-pin-controls]")) return; if (e.deltaY === 0) return; if (e.ctrlKey || e.metaKey) setOpacity((value) => Math.max(0.1, Math.min(1, value + (e.deltaY < 0 ? 0.1 : -0.1)))); else void resize(zoom + (e.deltaY < 0 ? 0.1 : -0.1)); }}
    title={collapsed && note ? note : t("screenshot.pinHint")}>
    <div data-testid="screenshot-pin-surface" className="absolute inset-0 flex items-center justify-center" style={{ opacity: collapsed ? 1 : opacity, backgroundColor: "#e2e2e2", backgroundImage: "conic-gradient(#c4c4c4 25%, transparent 0 50%, #c4c4c4 0 75%, transparent 0)", backgroundSize: "16px 16px" }}>
      <img data-testid="screenshot-pin-image" src={url} alt={t("screenshot.pin")} className="max-w-full max-h-full block pointer-events-none object-contain" style={collapsed ? { width: "100%", height: "100%" } : { width: init.width * zoom / (window.devicePixelRatio || 1), height: init.height * zoom / (window.devicePixelRatio || 1) }} draggable={false} />
    </div>
    <div className="absolute inset-0 pointer-events-none" style={{ boxShadow: "inset 0 0 0 1px rgba(22,119,255,0.6)" }} />
    {collapsed ? <>
      <button data-pin-controls data-testid="screenshot-pin-expand" title={t("screenshot.pinExpand")} aria-label={t("screenshot.pinExpand")} onClick={() => void collapse()}
        className="absolute bottom-0 right-0 p-1 rounded-tl bg-black/75 text-white"><Maximize2 size={16} /></button>
      {note && <p data-pin-controls data-testid="screenshot-pin-thumb-note" title={note}
        className="absolute top-0 left-0 right-0 truncate bg-black/75 text-white text-[10px] leading-4 px-1 cursor-help">{note}</p>}
    </> : <>
      <div data-pin-controls data-testid="screenshot-pin-toolbar" className="absolute top-1 right-1 flex gap-0.5 p-1 rounded-lg bg-black/80 text-white cursor-default">
        <button data-testid="screenshot-pin-copy" className={buttonClass} title={`${t("screenshot.copy")} (Ctrl/Cmd+C)`} aria-label={t("screenshot.copy")} disabled={busy} onClick={() => void copy()}><Copy size={16} /></button>
        <button data-testid="screenshot-pin-save" className={buttonClass} title={`${t("screenshot.save")} (Ctrl/Cmd+S)`} aria-label={t("screenshot.save")} disabled={busy} onClick={() => void save()}><Download size={16} /></button>
        <button data-testid="screenshot-pin-favorite" className={buttonClass} title={t(favoriteId ? "screenshot.pinUnfavorite" : "screenshot.pinFavorite")} aria-label={t(favoriteId ? "screenshot.pinUnfavorite" : "screenshot.pinFavorite")} aria-pressed={!!favoriteId} disabled={busy} onClick={() => void favorite()}><Star size={16} fill={favoriteId ? "#faad14" : "none"} color={favoriteId ? "#faad14" : "currentColor"} /></button>
        <button data-testid="screenshot-pin-collapse" className={buttonClass} title={t("screenshot.pinCollapse")} aria-label={t("screenshot.pinCollapse")} onClick={() => void collapse()}><Minimize2 size={16} /></button>
        <button data-testid="screenshot-pin-menu-toggle" className={buttonClass} title={t("screenshot.pinOptions")} aria-label={t("screenshot.pinOptions")} aria-expanded={menuOpen} onClick={() => (menuOpen ? hideTools() : openMenu())}><MoreHorizontal size={16} /></button>
        <button data-testid="screenshot-pin-close" className={buttonClass} title={t("screenshot.cancel")} aria-label={t("screenshot.cancel")} onClick={() => void close()}><X size={16} /></button>
      </div>

    </>}
    {!collapsed && note && <p data-pin-controls data-testid="screenshot-pin-note" title={note} className="absolute bottom-1 left-1 right-1 max-h-[30%] overflow-auto whitespace-pre-wrap break-words rounded bg-black/80 text-white text-[12px] p-2 cursor-text select-text">{note}</p>}
    {(error || notice) && <p data-pin-controls data-testid="screenshot-pin-notice" role={error ? "alert" : "status"} className="absolute bottom-1 left-1 right-1 rounded bg-black/85 text-white text-[11px] p-2 cursor-default break-words pointer-events-none">{error ?? notice}</p>}
  </div>;
}
