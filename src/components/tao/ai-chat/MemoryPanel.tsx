import { useEffect, useState } from "react";
import { isTauriRuntime } from "../../../lib/runtime";
import { taoText as tr } from "../i18n";
import { nativeCapabilities, type MemoryEntry } from "./nativeCapabilities";
import type { TaoChatController } from "./ports";
import { saveExportBlob } from "../../viewer/markdown/exportFiles";

export function MemoryPanel({ controller: _controller }: { controller: TaoChatController }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]); const [error, setError] = useState("");
  const refresh = () => { if (!isTauriRuntime()) return; void nativeCapabilities.listMemory().then(setEntries).catch((cause) => setError(String(cause))); };
  useEffect(refresh, []);
  const edit = async (entry: MemoryEntry) => { const content = window.prompt(tr("编辑内容"), entry.content); if (content === null) return; try { await nativeCapabilities.saveMemory({ ...entry, content }); refresh(); } catch (cause) { setError(String(cause)); } };
  const remove = async (entry: MemoryEntry) => { if (!entry.id) return; try { await nativeCapabilities.deleteMemory(entry.id); refresh(); } catch (cause) { setError(String(cause)); } };
  const exportAll = async () => { try { const data = await nativeCapabilities.exportMemory(); await saveExportBlob("tao-memory.json", new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); } catch (cause) { setError(String(cause)); } };
  return <section data-testid="tao-home-memory"><h3>{tr("记忆与技能")}</h3><button type="button" disabled={!isTauriRuntime()} onClick={() => void exportAll()}>{tr("导出")}</button>{entries.map((entry) => <article key={entry.id ?? entry.title}><strong>{entry.title}</strong><small>{tr(entry.kind)}</small><p>{entry.content}</p><button type="button" onClick={() => void edit(entry)}>{tr("编辑")}</button>{entry.id ? <button type="button" onClick={() => void remove(entry)}>{tr("删除")}</button> : null}</article>)}{!entries.length ? <p>{tr("暂无已确认的记忆、身份或技能")}</p> : null}{error ? <p role="alert">{error}</p> : null}</section>;
}
