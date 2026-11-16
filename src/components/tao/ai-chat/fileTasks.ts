import { Channel, invoke } from "@tauri-apps/api/core";
import { taoText as tr } from "../i18n";
import type { ContextChip, TaoProvider } from "./ports";

export interface TaoFileTask { id: string; phase: string; downloadedBytes: number; totalBytes?: number; percent?: number; error?: string }
export interface TaoFile { fileId: string; filename: string; mime: string; sizeBytes: number; reused?: boolean; threadId?: string; provider?: TaoProvider }
export interface FileTaskState { tasks: TaoFileTask[]; files: TaoFile[]; error: string }
let state: FileTaskState = { tasks: [], files: [], error: "" };
const listeners = new Set<() => void>();
const pending = new Map<string, Promise<TaoFile>>();
const update = (next: Partial<FileTaskState>) => { state = { ...state, ...next }; listeners.forEach((listener) => listener()); };

/** Upload ownership lives outside panels, so closing/reopening never cancels a task. */
export const taoFiles = {
  getState: () => state,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async refresh() {
    try { update({ tasks: await invoke<TaoFileTask[]>("deepseek_app_file_tasks") }); }
    catch (error) { update({ error: String(error) }); }
  },
  upload(threadId: string, localPath: string, provider: TaoProvider = "deepseek-app"): Promise<TaoFile> {
    const key = `${provider}:${threadId}:${localPath}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const onEvent = new Channel<TaoFileTask>();
    onEvent.onmessage = (task) => update({ tasks: [...state.tasks.filter((item) => item.id !== task.id), task] });
    const task = invoke<TaoFile>("deepseek_app_upload_file", { threadId, localPath, provider, onEvent }).then((result) => {
      const file = { ...result, provider, threadId };
      update({ files: [...state.files.filter((item) => item.fileId !== file.fileId), file], error: "" });
      return file;
    }).catch((error) => { update({ error: String(error) }); throw error; }).finally(() => { pending.delete(key); void taoFiles.refresh(); });
    pending.set(key, task);
    return task;
  },
  async cancel(id: string) { await invoke("deepseek_app_stop", { threadId: id }); await taoFiles.refresh(); },
  async remove(fileId: string) { await invoke("deepseek_app_delete_file", { fileId }); update({ files: state.files.filter((file) => file.fileId !== fileId) }); },
};

export function fileChip(file: TaoFile): ContextChip {
  return { id: `file:${file.fileId}`, kind: "file", label: file.filename, fileId: file.fileId, mime: file.mime, provider: file.provider ?? "deepseek-app", preview: tr(file.provider === "opencode-go" ? "文件将在发送时提交：{bytes} 字节" : "文件已上传：{bytes} 字节", { bytes: file.sizeBytes }), removable: true };
}
