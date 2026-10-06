import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import { closePin, copyImageToClipboard, loadScreenshotUrl, revokeScreenshotUrl, PIN_ACTION_EVENT, PINS_CHANGED_EVENT, type PinInit, type PinArrangement } from "../../lib/screenshot";

interface BoardPin extends PinInit { label: string; }
function BoardImage({ pin }: { pin: BoardPin }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true, loaded = "";
    void loadScreenshotUrl(pin.path).then((value) => { loaded = value; if (active) setUrl(value); else revokeScreenshotUrl(value); });
    return () => { active = false; revokeScreenshotUrl(loaded); };
  }, [pin.path]);
  return <img src={url} draggable={false} alt={pin.note ?? ""} className="w-full h-full min-h-0 object-contain" />;
}

/** One top-level window, so Wayland compositors need not support arbitrary
 * positioning of individual surfaces. Originals remain independently owned. */
export function PinBoard() {
  const t = useT();
  const [pins, setPins] = useState<BoardPin[]>([]);
  const [mode, setMode] = useState<PinArrangement>("tile");
  const [compact, setCompact] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const refresh = async () => {
    try { setPins(await invoke<BoardPin[]>("screenshot_board_pins")); }
    catch (e) { setError(String(e)); }
  };
  useEffect(() => {
    let active = true;
    const unlisteners: (() => void)[] = [];
    void refresh();
    void listen(PINS_CHANGED_EVENT, () => void refresh()).then((u) => { if (active) unlisteners.push(u); else u(); });
    void listen<{ action: string; mode?: PinArrangement }>(PIN_ACTION_EVENT, ({ payload }) => {
      if (payload.mode) setMode(payload.mode);
      if (payload.action === "collapse") setCompact(true);
      if (payload.action === "expand") setCompact(false);
    }).then((u) => { if (active) unlisteners.push(u); else u(); });
    const resize = () => void refresh();
    window.addEventListener("focus", resize);
    return () => { active = false; unlisteners.forEach((u) => u()); window.removeEventListener("focus", resize); };
  }, []);
  const columns = mode === "stackRight" ? "1fr" : mode === "stackBottom" ? `repeat(${Math.max(1, pins.length)}, minmax(160px, 1fr))` : "repeat(auto-fit, minmax(220px, 1fr))";
  return <section data-testid="screenshot-pin-board" data-layout={mode} className="fixed inset-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]">
    <header className="flex flex-wrap gap-2 p-3 border-b border-[var(--taomni-divider)] text-[12px]">
      <h1 className="mr-auto font-medium">{t("screenshot.pinBoard")}</h1>
      <select data-testid="screenshot-board-layout" aria-label={t("screenshot.pinArrange")} value={mode} onChange={(e) => setMode(e.target.value as PinArrangement)}>
        {(["tile", "cascade", "stackRight", "stackBottom"] as const).map((m) => <option key={m} value={m}>{t(`screenshot.pin${m[0].toUpperCase()}${m.slice(1)}`)}</option>)}
      </select>
      <button data-testid="screenshot-board-select-all" onClick={() => setSelected(pins.map((p) => p.label))}>{t("screenshot.selectAllPins")}</button>
      <button data-testid="screenshot-board-collapse" onClick={() => setCompact(!compact)}>{t(compact ? "screenshot.batchExpand" : "screenshot.batchCollapse")}</button>
      <button data-testid="screenshot-board-close-selected" disabled={!selected.length} onClick={() => setConfirm(true)}>{t("screenshot.closeSelectedPins")}</button>
      <button data-testid="screenshot-board-close" onClick={() => void getCurrentWindow().close()}>{t("screenshot.cancel")}</button>
    </header>
    {confirm && <div role="alert" className="p-3 text-[12px]">{t("screenshot.closeAllPinsConfirm")}
      <button data-testid="screenshot-board-confirm" onClick={() => { void Promise.all(selected.map(closePin)).then(() => { setConfirm(false); setSelected([]); return refresh(); }).catch((e) => setError(String(e))); }}>{t("screenshot.done")}</button>
      <button onClick={() => setConfirm(false)}>{t("screenshot.cancel")}</button></div>}
    {error && <p role="alert">{error}</p>}
    <main className="flex-1 min-h-0 overflow-auto p-3" style={{ display: "grid", gridTemplateColumns: columns, gap: mode === "cascade" ? 0 : 12, alignContent: "start" }}>
      {pins.map((pin, i) => <article data-testid="screenshot-board-pin" key={pin.label} className="rounded-lg border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-2 flex flex-col"
        style={{ height: compact ? 110 : 300, marginTop: mode === "cascade" ? (i % 6) * 24 : 0 }}>
        <div className="flex gap-2 text-[12px] mb-2"><input data-testid="screenshot-board-select" aria-label={pin.note || pin.label} type="checkbox" checked={selected.includes(pin.label)} onChange={(e) => setSelected((all) => e.target.checked ? [...all, pin.label] : all.filter((l) => l !== pin.label))} />
          <span className="truncate flex-1">{pin.note || pin.label}</span>
          <button data-testid="screenshot-board-copy" onClick={() => void copyImageToClipboard(pin.path).catch((e) => setError(String(e)))}>{t("screenshot.copy")}</button></div>
        <BoardImage pin={pin} />
      </article>)}
    </main>
  </section>;
}
