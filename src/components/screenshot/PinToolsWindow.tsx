import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import { formatUnknownError } from "../../lib/appDialogs";
import { listPins, PIN_TOOL_EVENT, PIN_VIEW_EVENT, PINS_CHANGED_EVENT, type PinView, type PinSummary, type PinBatchAction, type PinArrangement } from "../../lib/screenshot";

/** Controls have their own window so even a thumbnail pin remains usable. */
export function PinToolsWindow() {
  const t = useT();
  const [target, setTarget] = useState("");
  const [view, setView] = useState<PinView>({ zoom: 1, opacity: 1, note: "", busy: false, error: null, notice: null });
  const sourceNote = useRef("");
  const sourceRevision = useRef(-1);
  const pendingZoom = useRef<number | null>(null);
  const confirmedZoom = useRef(1);
  const pendingOpacity = useRef<number | null>(null);
  const confirmedOpacity = useRef(1);
  const [localError, setLocalError] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const noteDraftRef = useRef("");
  const noteDirtyRef = useRef(false);
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [pins, setPins] = useState<PinSummary[]>([]);
  const [menuTab, setMenuTab] = useState<"pin" | "all">("pin");
  const [confirmCloseAll, setConfirmCloseAll] = useState(false);
  const { zoom, opacity, busy } = view;
  useEffect(() => {
    let active = true;
    const unlisteners: (() => void)[] = [];
    const refresh = () => { void listPins().then((items) => { if (active) setPins(items); }).catch((e) => { if (active) setLocalError(formatUnknownError(e)); }); };
    void (async () => {
      const offView = await listen<PinView>(PIN_VIEW_EVENT, ({ payload }) => {
        if (!active) return;
        if (payload.revision !== undefined) {
          if (payload.revision < sourceRevision.current) return;
          sourceRevision.current = payload.revision;
        }
        // Synchronize incoming notes in the same update as the source view.
        // A deferred effect must not overwrite typing after controls appear.
        // A source reply can arrive after the user has started typing (the
        // native WebView is especially prone to this around resize events).
        // Keep the local draft authoritative until it is explicitly saved.
        const domDraft = noteInputRef.current?.value;
        const hasUncommittedDomDraft = domDraft !== undefined && domDraft !== sourceNote.current;
        if (!noteDirtyRef.current && !hasUncommittedDomDraft && payload.note !== sourceNote.current) {
          sourceNote.current = payload.note;
          noteDraftRef.current = payload.note;
          // The textarea is intentionally uncontrolled after mount so a
          // source zoom/opacity reply cannot reconcile over a DOM draft that
          // a WebView input event has already recorded.
          if (noteInputRef.current) noteInputRef.current.value = payload.note;
          setNoteDraft(payload.note);
        }
        confirmedOpacity.current = payload.opacity;
        if (pendingZoom.current === null) confirmedZoom.current = payload.zoom;
        else if (pendingZoom.current === payload.zoom) confirmedZoom.current = payload.zoom;
        if (pendingOpacity.current === payload.opacity) pendingOpacity.current = null;
        // Keep keyboard repeats and slider drags responsive while the source
        // window acknowledges the latest value. Older replies must not reset it.
        setView({
          ...payload,
          zoom: pendingZoom.current ?? payload.zoom,
          opacity: pendingOpacity.current === null ? payload.opacity : pendingOpacity.current,
        });
      });
      if (!active) { offView(); return; } unlisteners.push(offView);
      const offPins = await listen(PINS_CHANGED_EVENT, refresh);
      if (!active) { offPins(); return; } unlisteners.push(offPins);
      const data = await invoke<{ label: string; view: PinView }>("screenshot_pin_tools_init");
      if (!active) return;
      confirmedOpacity.current = data.view.opacity;
      confirmedZoom.current = data.view.zoom;
      pendingZoom.current = null;
      if (data.view.revision !== undefined) sourceRevision.current = data.view.revision;
      sourceNote.current = data.view.note;
      noteDraftRef.current = data.view.note;
      noteDirtyRef.current = false;
      setNoteDraft(data.view.note);
      setTarget(data.label); setView(data.view); refresh();
      await emitTo(data.label, PIN_TOOL_EVENT, { action: "sync" });
    })().catch((e) => { if (active) setLocalError(formatUnknownError(e)); });
    return () => { active = false; unlisteners.forEach((off) => off()); };
  }, []);
  const send = async (action: string, value?: unknown): Promise<boolean> => {
    setLocalError(null);
    try { await emitTo(target, PIN_TOOL_EVENT, { action, value }); return true; }
    catch (e) {
      if (action === "opacity" && pendingOpacity.current === value) {
        pendingOpacity.current = null;
        setView((current) => ({ ...current, opacity: confirmedOpacity.current }));
      }
      if (action === "zoom" && pendingZoom.current === value) {
        pendingZoom.current = null;
        setView((current) => ({ ...current, zoom: confirmedZoom.current }));
      }
      setLocalError(formatUnknownError(e));
      return false;
    }
  };
  const close = () => { void getCurrentWindow().close().catch((e) => setLocalError(formatUnknownError(e))); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const resize = (value: number) => {
    pendingZoom.current = value;
    setView((current) => ({ ...current, zoom: value }));
    void send("zoom", value);
  };
  const setOpacity = (value: number) => {
    pendingOpacity.current = value === confirmedOpacity.current ? null : value;
    setView((current) => ({ ...current, opacity: value }));
    void send("opacity", value);
  };
  const updateNoteDraft = (value: string) => {
    noteDraftRef.current = value;
    noteDirtyRef.current = true;
    setNoteDraft(value);
  };
  // Keep a native listener in addition to React's handler. Native QA and a
  // few WebView input paths dispatch an untrusted `input` event that can miss
  // React's delegated ChangeEventPlugin, while the DOM value is already the
  // user's draft. Recording it here prevents the next source update from
  // restoring the old controlled value.
  useEffect(() => {
    const input = noteInputRef.current;
    if (!input) return;
    const onInput = () => updateNoteDraft(input.value);
    input.addEventListener("input", onInput);
    return () => input.removeEventListener("input", onInput);
  }, [target]);
  const saveNote = async () => {
    // Read the element as the final source of truth as well. This covers
    // WebView automation/input paths that update textarea.value before React's
    // synthetic event has reached the component.
    const value = noteInputRef.current?.value ?? noteDraftRef.current;
    noteDraftRef.current = value;
    if (await send("note", value)) {
      sourceNote.current = value;
      noteDirtyRef.current = false;
      noteDraftRef.current = value;
      setNoteDraft(value);
    }
  };
  const openPinEditor = () => send("edit");
  const editExternal = (choose: boolean) => send("external", choose);
  const arrange = (mode: PinArrangement) => send("arrange", mode);
  const batch = async (action: PinBatchAction) => { await send("batch", action); setConfirmCloseAll(false); };
  const focusPin = (label: string) => send("focus", label);
  const run = (work: () => Promise<unknown>) => work();
  return <section data-testid="screenshot-pin-tools-window" className="fixed inset-0 flex flex-col bg-[var(--taomni-panel-bg)] text-[var(--taomni-text)]">
    <header className="flex items-center justify-between p-3 border-b border-[var(--taomni-divider)]">
      <h1 className="text-sm font-medium">{t("screenshot.pinOptions")}</h1>
      <button data-testid="screenshot-pin-tools-close" onClick={close} aria-label={t("screenshot.cancel")}>×</button>
    </header>
      {target ? <div data-pin-controls data-testid="screenshot-pin-menu" className="flex-1 flex min-h-0 flex-col rounded-lg bg-black/90 text-white text-[12px] cursor-default">
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
            <span data-testid="screenshot-pin-zoom" data-pending-zoom={pendingZoom.current ?? ""} className="min-w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button data-testid="screenshot-pin-zoom-in" className="w-8 h-8 shrink-0 rounded bg-white/15 hover:bg-white/25" aria-label={t("screenshot.pinZoomIn")} onClick={() => void resize(zoom + 0.1)}>+</button>
            <button data-testid="screenshot-pin-reset" className="ml-auto h-8 px-3 rounded bg-white/15 hover:bg-white/25" onClick={() => { setOpacity(1); void resize(1); }}>{t("screenshot.pinReset")}</button>
          </div>
          <label className="flex items-center gap-2">{t("screenshot.pinOpacity")}
            <input data-testid="screenshot-pin-opacity" aria-label={t("screenshot.pinOpacity")} type="range" min={10} max={100} step={10} value={Math.round(opacity * 100)} onChange={(e) => setOpacity(Number(e.target.value) / 100)} className="min-w-0 flex-1" />
            <span className="tabular-nums w-9 text-right">{Math.round(opacity * 100)}%</span>
          </label>
          <label className="block">{t("screenshot.pinNote")}
            <textarea ref={noteInputRef} data-testid="screenshot-pin-note-input" aria-label={t("screenshot.pinNote")} maxLength={500} rows={2} defaultValue={noteDraft}
              onInput={(e) => updateNoteDraft(e.currentTarget.value)} onChange={(e) => updateNoteDraft(e.target.value)} className="block w-full rounded p-2 bg-white/15 mt-1" />
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
      </div> : <p role="status" className="p-3 text-sm">{t("common.loading")}</p>}
    {(localError || view.error || view.notice) && <p role={localError || view.error ? "alert" : "status"} className="p-3 text-[12px]">{localError ?? view.error ?? view.notice}</p>}
  </section>;
}
