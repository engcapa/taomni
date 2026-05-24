import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { History, Download, Trash2, Loader2 } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";

/**
 * Chat history retention + export controls.
 *
 * - Retention sweep is automatic on Drawer mount (30 days), but the user can
 *   trigger it manually here and adjust the keep window.
 * - Export writes a JSON archive of every thread + message to a user-chosen
 *   path. The frontend goes through the existing select_save_file_path
 *   command so the dialog matches the rest of NewMob.
 */
export function ChatHistoryPanel() {
  const [keepDays, setKeepDays] = useState(30);
  const [purging, setPurging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const purge = useChatStore((s) => s.purgeOldThreads);
  const exportArchive = useChatStore((s) => s.exportArchive);

  const handlePurge = async () => {
    setPurging(true);
    setStatus(null);
    try {
      const deleted = await purge(keepDays);
      setStatus(deleted > 0 ? `已删除 ${deleted} 条过期对话` : "没有需要清理的对话");
    } catch (e) {
      setStatus(`清理失败：${String(e)}`);
    } finally {
      setPurging(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setStatus(null);
    try {
      const path = await invoke<string | null>("select_save_file_path", {
        defaultName: `newmob-chat-${new Date().toISOString().slice(0, 10)}.json`,
        currentPath: null,
      });
      if (!path) {
        setExporting(false);
        return;
      }
      const total = await exportArchive(path);
      setStatus(`已导出 ${total} 条消息到 ${path}`);
    } catch (e) {
      setStatus(`导出失败：${String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <History className="w-4 h-4 text-[var(--moba-accent)]" />
        <div className="text-[13px] font-semibold flex-1">对话历史管理</div>
      </div>

      <div className="grid grid-cols-12 gap-x-3 gap-y-2.5 text-[12px] items-end">
        <label className="col-span-6">
          <span className="block mb-1 text-[var(--moba-text-muted)]">保留天数</span>
          <input
            className="moba-input h-7 w-24"
            type="number"
            min={1}
            max={365}
            value={keepDays}
            aria-label="Chat history retention days"
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next > 0) setKeepDays(Math.min(365, Math.round(next)));
            }}
          />
        </label>

        <div className="col-span-6 flex justify-end gap-2">
          <button
            type="button"
            className="moba-btn h-7 px-2 text-[11px] inline-flex items-center gap-1.5"
            onClick={handlePurge}
            disabled={purging}
          >
            {purging ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            清理过期对话
          </button>

          <button
            type="button"
            className="moba-btn h-7 px-2 text-[11px] inline-flex items-center gap-1.5"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
            导出全部对话
          </button>
        </div>
      </div>

      <p className="text-[11px] text-[var(--moba-text-muted)] leading-snug">
        默认 30 天自动清理，仅删除超过保留期的对话；导出生成 JSON 文件，可手动压缩归档。
      </p>

      {status && (
        <div className="text-[11px] text-[var(--moba-accent)] rounded border border-[var(--moba-divider)] bg-[var(--moba-bg)] px-2 py-1.5">
          {status}
        </div>
      )}
    </div>
  );
}
