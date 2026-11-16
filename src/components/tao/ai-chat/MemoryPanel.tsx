import { useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../../../lib/runtime";
import { taoText as tr } from "../i18n";
import { nativeCapabilities, type MemoryEntry } from "./nativeCapabilities";
import type { TaoChatController } from "./ports";
import { saveExportBlob } from "../../viewer/markdown/exportFiles";

export function MemoryPanel({ controller: _controller }: { controller: TaoChatController }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const generation = ++owner.current;
    if (isTauriRuntime()) void nativeCapabilities.listMemory()
      .then((items) => { if (owner.current === generation) setEntries(items); })
      .catch((cause) => { if (owner.current === generation) setError(String(cause)); });
    return () => { owner.current++; };
  }, []);

  const run = async (action: () => Promise<void>, refresh: boolean) => {
    if (pending.current) return;
    pending.current = true;
    const generation = ++owner.current;
    setBusy(true); setError("");
    try {
      await action();
      const items = refresh ? await nativeCapabilities.listMemory() : undefined;
      if (owner.current !== generation) return;
      if (items) { setEntries(items); setEditing(null); }
    } catch (cause) {
      if (owner.current === generation) setError(String(cause));
    } finally {
      pending.current = false;
      if (owner.current === generation) setBusy(false);
    }
  };
  const save = () => {
    if (editing) void run(async () => { await nativeCapabilities.saveMemory({ ...editing, content: draft }); }, true);
  };
  const exportAll = () => run(async () => {
    const data = await nativeCapabilities.exportMemory();
    await saveExportBlob("tao-memory.json", new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  }, false);

  return <section data-testid="tao-home-memory">
    <h3>{tr("记忆与技能")}</h3>
    <button type="button" data-testid="tao-home-memory-export" disabled={busy || !isTauriRuntime()} onClick={() => void exportAll()}>{tr("导出")}</button>
    {entries.map((entry) => <article key={entry.id ?? entry.title} data-testid="tao-home-memory-entry" data-memory-id={entry.id}>
      <strong>{entry.title}</strong><small>{tr(entry.kind)}</small>
      {editing === entry ? <form onSubmit={(event) => { event.preventDefault(); save(); }} onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); setEditing(null); }
      }}>
        <textarea data-testid="tao-home-memory-content" aria-label={tr("编辑内容")} className="taomni-input w-full min-h-24" value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} autoFocus />
        <button type="submit" data-testid="tao-home-memory-save" disabled={busy}>{tr("保存")}</button>
        <button type="button" data-testid="tao-home-memory-cancel" disabled={busy} onClick={() => setEditing(null)}>{tr("取消")}</button>
      </form> : <>
        <p>{entry.content}</p>
        <button type="button" data-testid="tao-home-memory-edit" disabled={busy} onClick={() => { setEditing(entry); setDraft(entry.content); setError(""); }}>{tr("编辑")}</button>
        {entry.id ? <button type="button" data-testid="tao-home-memory-delete" disabled={busy} onClick={() => void run(async () => { await nativeCapabilities.deleteMemory(entry.id!); }, true)}>{tr("删除")}</button> : null}
      </>}
    </article>)}
    {!entries.length ? <p>{tr("暂无已确认的记忆、身份或技能")}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
