import { useEffect, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../../../lib/runtime";
import { taoText as tr } from "../i18n";
import { fileChip, taoFiles } from "./fileTasks";
import type { TaoChatController } from "./ports";

export function FilesPanel({ controller }: { controller: TaoChatController }) {
  const files = useSyncExternalStore(taoFiles.subscribe, taoFiles.getState, taoFiles.getState);
  const [error, setError] = useState("");
  const threadId = controller.getState().activeThreadId;
  const provider = controller.getState().composer.provider ?? "deepseek-app";
  const add = async (paths: string[]) => {
    if (!threadId) return;
    for (const path of paths) {
      try {
        const file = await taoFiles.upload(threadId, path, provider);
        setError("");
        // A completed upload belongs to its original thread, even if the user switched.
        if (controller.getState().activeThreadId === threadId && (controller.getState().composer.provider ?? "deepseek-app") === provider) {
          const chip = fileChip(file);
          controller.setChips([...controller.getState().composer.chips.filter((item) => item.id !== chip.id), chip]);
        }
      } catch (cause) { setError(String(cause)); }
    }
  };
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void taoFiles.refresh();
    const timer = window.setInterval(() => void taoFiles.refresh(), 1200);
    const unlisten = listen<{ paths?: string[] }>("tauri://drag-drop", ({ payload }) => { if (payload.paths?.length) void add(payload.paths); });
    return () => { clearInterval(timer); void unlisten.then((dispose) => dispose()); };
  }, [threadId, provider]);
  const choose = async () => {
    try {
      const paths = await open({ multiple: true, filters: [{ name: tr("文档、图片和代码"), extensions: ["pdf", "png", "jpg", "jpeg", "webp", "gif", "docx", "pptx", "txt", "md", "csv", "json", "xml", "html", "ts", "tsx", "js", "rs", "py", "java", "sql", "yaml", "yml"] }] });
      if (paths) await add(Array.isArray(paths) ? paths : [paths]);
    } catch (cause) { setError(String(cause)); }
  };
  const state = controller.getState();
  const references = state.composer.chips.filter((chip) => chip.fileId);
  return <section data-testid="tao-home-files"><h3>{tr("文件")}</h3><p>{tr(provider === "opencode-go" ? "选择或拖入文件，文件会暂存到当前对话，发送问题时提交给模型。关闭侧栏不会移除附件。" : "选择或拖入 PDF / 图片。上传在后台继续，关闭侧栏不会取消。")}</p><button type="button" data-testid="tao-home-file-choose" disabled={!isTauriRuntime()} onClick={() => void choose()}>{tr("选择文件")}</button>{!isTauriRuntime() ? <p>{tr("文件上传需要桌面应用。")}</p> : null}{error || files.error ? <p role="alert">{error || files.error}</p> : null}
    {files.tasks.map((task) => <div key={task.id} data-testid="tao-home-file-task"><strong>{tr(task.phase)}</strong><progress value={task.percent} max={100} /><small>{task.downloadedBytes} / {task.totalBytes ?? "?"} bytes {task.percent === undefined ? "" : `${task.percent.toFixed(0)}%`}</small>{task.error ? <p role="alert">{task.error}</p> : null}{["connecting", "uploading"].includes(task.phase) ? <button type="button" onClick={() => void taoFiles.cancel(task.id).catch((cause) => setError(String(cause)))}>{tr("取消")}</button> : null}</div>)}
    {files.files.filter((file) => (!file.threadId || file.threadId === threadId) && (file.provider ?? "deepseek-app") === provider).map((file) => <div key={file.fileId}><strong>{state.ui.demoMode ? tr("文件") : file.filename}</strong><small>{file.sizeBytes} bytes</small><button type="button" onClick={() => { const chip = fileChip(file); controller.setChips([...state.composer.chips.filter((item) => item.id !== chip.id), chip]); }}>{tr("加入上下文")}</button><button type="button" onClick={() => void taoFiles.remove(file.fileId).then(() => controller.setChips(controller.getState().composer.chips.filter((chip) => chip.fileId !== file.fileId))).catch((cause) => setError(String(cause)))}>{tr("删除")}</button></div>)}
    {references.map((chip) => <div key={chip.id}>{state.ui.demoMode ? tr("文件") : chip.label}<button type="button" onClick={() => controller.removeChip(chip.id)}>{tr("移除引用")}</button></div>)}
  </section>;
}
