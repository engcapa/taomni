import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFileBytes } from "../../../lib/ipc";
import { isTauriRuntime } from "../../../lib/runtime";
import { saveExportBlob } from "../../viewer/markdown/exportFiles";
import { taoText as tr } from "../i18n";
import type { TaoChatController, TaoThread } from "./ports";

export function ArchivePanel({ controller }: { controller: TaoChatController }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setStatus("");
    try { await action(); } catch (error) { setStatus(String(error)); } finally { setBusy(false); }
  };
  const exportArchive = async () => {
    const bytes = await invoke<number[]>("deepseek_app_export_archive", {});
    await saveExportBlob("tao-history.zip", new Blob([Uint8Array.from(bytes)], { type: "application/zip" }));
    setStatus(tr("已导出"));
  };
  const importArchive = async () => {
    const path = await open({ multiple: false, filters: [{ name: "DeepSeek ZIP v3", extensions: ["zip"] }] });
    if (!path || Array.isArray(path)) return;
    const result = await invoke<{ threads: TaoThread[]; count: number }>("deepseek_app_import_archive", { bytes: Array.from(await readFileBytes(path)) });
    controller.hydrateThreads([...Object.values(controller.getState().threads), ...result.threads]);
    setStatus(tr("已导入 {count} 个新对话", { count: result.count }));
  };
  return <section data-testid="tao-home-archive"><h3>{tr("导入导出")}</h3><p>{tr("导入会创建新 Tao 对话，保留已有记录。支持 DeepSeek ZIP v3。")}</p><button type="button" data-testid="tao-home-archive-import" disabled={busy || !isTauriRuntime()} onClick={() => void run(importArchive)}>{tr("导入 ZIP")}</button><button type="button" data-testid="tao-home-archive-export" disabled={busy || !isTauriRuntime()} onClick={() => void run(exportArchive)}>{tr("导出 ZIP")}</button>{busy ? <p>{tr("正在处理…")}</p> : null}{status ? <p role="status">{status}</p> : null}{!isTauriRuntime() ? <p>{tr("历史导入导出需要桌面应用。")}</p> : null}</section>;
}
