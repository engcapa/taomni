import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, Download, Maximize2, Minimize2, MoreHorizontal, Star, X } from "lucide-react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useT } from "../../lib/i18n";
import { formatUnknownError } from "../../lib/appDialogs";
import {
  addScreenshotFavorite, removeScreenshotFavorite, copyImageToClipboard, saveImageToFile,
  closePin, fetchPinInit, loadScreenshotUrl, revokeScreenshotUrl, type PinInit,
  setPinCompact, setPinNote, listPins, arrangePins, pinsBatch, focusPin, openImageEditor, openPinEditor,
  PIN_ACTION_EVENT, PINS_CHANGED_EVENT, type PinSummary, type PinBatchAction, type PinArrangement,
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
  const [noteDraft, setNoteDraft] = useState("");
  const [pins, setPins] = useState<PinSummary[]>([]);
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const [menuTab, setMenuTab] = useState<"pin" | "all">("pin");
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
      setNote(pin.note ?? ""); setNoteDraft(pin.note ?? "");
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
      setMenuOpen(false);
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
  useEffect(() => {
    if (!menuOpen) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const refresh = () => { void listPins().then((items) => { if (active) setPins(items); }).catch((e) => { if (active) setError(formatUnknownError(e)); }); };
    refresh();
    void listen(PINS_CHANGED_EVENT, refresh).then((fn) => { if (!active) fn(); else unlisten = fn; }).catch((e) => { if (active) setError(formatUnknownError(e)); });
    return () => { active = false; unlisten?.(); };
  }, [menuOpen]);
  const saveNote = () => run(async () => {
    const value = await setPinNote(noteDraft);
    setNote(value); setNoteDraft(value);
    setNotice(t("screenshot.saved"));
  });
  const batch = (action: PinBatchAction) => run(async () => { await pinsBatch(action); setConfirmCloseAll(false); });
  const arrange = (mode: PinArrangement) => run(async () => { await arrangePins(mode); setMenuOpen(false); });
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

  const buttonClass = "w-8 h-8 flex items-center justify-center rounded hover:bg-white/20 disabled:opacity-40";
  const openMenu = () => { setMenuTab("pin"); setMenuOpen(true); };
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
        <button data-testid="screenshot-pin-menu-toggle" className={buttonClass} title={t("screenshot.pinOptions")} aria-label={t("screenshot.pinOptions")} aria-expanded={menuOpen} onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}><MoreHorizontal size={16} /></button>
        <button data-testid="screenshot-pin-close" className={buttonClass} title={t("screenshot.cancel")} aria-label={t("screenshot.cancel")} onClick={() => void close()}><X size={16} /></button>
      </div>
      {menuOpen && <div data-pin-controls data-testid="screenshot-pin-menu" className="absolute top-11 right-1 left-1 bottom-1 flex min-h-0 flex-col rounded-lg bg-black/90 text-white text-[12px] cursor-default">
        <div role="tablist" aria-label={t("screenshot.pinOptions")} className="flex gap-1 p-2">
          <button role="tab" data-testid="screenshot-pin-tab-pin" aria-selected={menuTab === "pin"} onClick={() => setMenuTab("pin")}
            className={`flex-1 h-8 rounded ${menuTab === "pin" ? "bg-white/25 font-medium" : "bg-white/10 hover:bg-white/20"}`}>{t("screenshot.pinTabPin")}</button>
          <button role="tab" data-testid="screenshot-pin-tab-all" aria-selected={menuTab === "all"} onClick={() => setMenuTab("all")}
            className={`flex-1 h-8 rounded ${menuTab === "all" ? "bg-white/25 font-medium" : "bg-white/10 hover:bg-white/20"}`}>{t("screenshot.pinTabAll")}</button>
        </div>
        {menuTab === "pin" ? <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 space-y-3">
          <div className="flex items-center gap-2">
            <span className="shrink-0">{t("screenshot.pinZoom")}</span>
            <button data-testid="screenshot-pin-zoom-out" className="w-8 h-8 shrink-0 rounded bg-white/15 hover:bg-white/25" aria-label={t("screenshot.pinZoomOut")} onClick={() => void resize(zoom - 0.1)}>−</button>
            <span data-testid="screenshot-pin-zoom" className="min-w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button data-testid="screenshot-pin-zoom-in" className="w-8 h-8 shrink-0 rounded bg-white/15 hover:bg-white/25" aria-label={t("screenshot.pinZoomIn")} onClick={() => void resize(zoom + 0.1)}>+</button>
            <button data-testid="screenshot-pin-reset" className="ml-auto h-8 px-3 rounded bg-white/15 hover:bg-white/25" onClick={() => { setOpacity(1); void resize(1); }}>{t("screenshot.pinReset")}</button>
          </div>
          <label className="flex items-center gap-2">{t("screenshot.pinOpacity")}
            <input data-testid="screenshot-pin-opacity" aria-label={t("screenshot.pinOpacity")} type="range" min={10} max={100} step={10} value={Math.round(opacity * 100)} onChange={(e) => setOpacity(Number(e.target.value) / 100)} className="min-w-0 flex-1" />
            <span className="tabular-nums w-9 text-right">{Math.round(opacity * 100)}%</span>
          </label>
          <label className="block">{t("screenshot.pinNote")}
            <textarea data-testid="screenshot-pin-note-input" aria-label={t("screenshot.pinNote")} maxLength={500} rows={2} value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)} className="block w-full rounded p-2 bg-white/15 mt-1" />
          </label>
          <button data-testid="screenshot-pin-note-save" disabled={busy} className="w-full h-8 rounded bg-white/15 hover:bg-white/25 disabled:opacity-40" onClick={() => void saveNote()}>{t("screenshot.save")}</button>
          <div className="space-y-1.5">
            <button data-testid="screenshot-pin-edit" disabled={busy} className="w-full h-8 rounded bg-white/15 hover:bg-white/25 disabled:opacity-40" onClick={() => void run(openPinEditor)}>{t("screenshot.editImage")}</button>
            <button data-testid="screenshot-pin-external" disabled={busy} className="w-full h-8 rounded bg-white/15 hover:bg-white/25 disabled:opacity-40" onClick={() => void editExternal(false)}>{t("screenshot.externalEditor")}</button>
            <button data-testid="screenshot-pin-choose-editor" disabled={busy} className="w-full h-8 rounded bg-white/15 hover:bg-white/25 disabled:opacity-40" onClick={() => void editExternal(true)}>{t("screenshot.chooseEditor")}</button>
          </div>
          <p data-testid="screenshot-pin-help" className="leading-relaxed text-white/75">{t("screenshot.pinHelp")}</p>
        </div> : <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 space-y-3">
          <div>
            <p className="mb-1.5 text-white/60">{t("screenshot.pinArrange")}</p>
            <div className="grid grid-cols-2 gap-1.5">{(["tile", "cascade", "stackRight", "stackBottom"] as const).map((mode) =>
              <button key={mode} data-testid={`screenshot-pins-${mode}`} disabled={busy} className="h-8 rounded bg-white/15 hover:bg-white/25 disabled:opacity-40" onClick={() => void arrange(mode)}>{t(`screenshot.pin${mode[0].toUpperCase()}${mode.slice(1)}`)}</button>)}</div>
          </div>
          <div className="space-y-1.5">
            {(["collapse", "expand", "resetOpacity"] as const).map((action) =>
              <button key={action} data-testid={`screenshot-pins-${action}`} disabled={busy} className="w-full h-8 rounded bg-white/15 hover:bg-white/25 disabled:opacity-40" onClick={() => void batch(action)}>{t(`screenshot.batch${action[0].toUpperCase()}${action.slice(1)}`)}</button>)}
            <button data-testid="screenshot-pins-close-all" className="w-full h-8 rounded bg-white/15 hover:bg-white/25" onClick={() => setConfirmCloseAll(true)}>{t("screenshot.closeAllPins")}</button>
            {confirmCloseAll && <div role="alert" className="rounded p-2 bg-white/15 leading-relaxed">{t("screenshot.closeAllPinsConfirm")}
              <div className="mt-1.5 flex gap-2">
                <button data-testid="screenshot-pins-close-confirm" disabled={busy} className="flex-1 h-8 rounded bg-white/25 disabled:opacity-40" onClick={() => void batch("closeAll")}>{t("screenshot.done")}</button>
                <button className="flex-1 h-8 rounded bg-white/15 hover:bg-white/25" onClick={() => setConfirmCloseAll(false)}>{t("screenshot.cancel")}</button>
              </div></div>}
          </div>
          <div>
            <p className="mb-1.5 text-white/60">{t("screenshot.pinFocusList")}</p>
            <ul data-testid="screenshot-pin-list" className="max-h-28 overflow-auto space-y-1">{pins.map((pin) => <li key={pin.label}>
              <button className="text-left truncate w-full h-8 px-2 rounded bg-white/10 hover:bg-white/20" data-testid="screenshot-pin-focus" onClick={() => void run(() => focusPin(pin.label))}>{pin.note || `${t("screenshot.pin")} ${pin.order}`} · {pin.width} × {pin.height}</button>
            </li>)}</ul>
          </div>
        </div>}
      </div>}
    </>}
    {!collapsed && note && !menuOpen && <p data-pin-controls data-testid="screenshot-pin-note" title={note} className="absolute bottom-1 left-1 right-1 max-h-[30%] overflow-auto whitespace-pre-wrap break-words rounded bg-black/80 text-white text-[12px] p-2 cursor-text select-text">{note}</p>}
    {(error || notice) && <p data-pin-controls data-testid="screenshot-pin-notice" role={error ? "alert" : "status"} className="absolute bottom-1 left-1 right-1 rounded bg-black/85 text-white text-[11px] p-2 cursor-default break-words">{error ?? notice}</p>}
  </div>;
}
