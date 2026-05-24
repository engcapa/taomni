import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal, Loader2 } from "lucide-react";
import { CommandPreviewCard, type CommandPreviewData } from "../voice/CommandPreviewCard";
import { copyCommandToClipboard, updateAuditOutcome } from "../../lib/voice/commandExecutor";
import { useAppStore } from "../../stores/appStore";

interface AiShellPanelProps {
  /** Whether the "voice→shell" experimental feature is enabled. */
  enabled: boolean;
  onToggle: () => void;
}

export function AiShellPanel({ enabled, onToggle }: AiShellPanelProps) {
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<CommandPreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeTabId = useAppStore((s) => s.activeTabId);

  const handleGenerate = async () => {
    if (!description.trim()) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const result = await invoke<CommandPreviewData>("generate_shell_command", {
        description: description.trim(),
        cwd: null,
        sessionId: activeTabId,
      });
      setPreview(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async (command: string, auditId: number, edited: boolean) => {
    // In v2.1 we inject into the active terminal via write_terminal.
    // The active tab ID is the terminal session ID.
    if (activeTabId) {
      const withNewline = command.endsWith("\n") ? command : command + "\n";
      const encoded = btoa(unescape(encodeURIComponent(withNewline)));
      await invoke("write_terminal", { id: activeTabId, data: encoded });
      await updateAuditOutcome(auditId, edited ? "edited" : "executed");
    }
    setPreview(null);
    setDescription("");
  };

  const handleCancel = async (auditId: number) => {
    await updateAuditOutcome(auditId, "cancelled").catch(() => {});
    setPreview(null);
  };

  const handleCopy = async (command: string) => {
    await copyCommandToClipboard(command);
  };

  return (
    <div className="space-y-3">
      {/* Feature toggle */}
      <div
        className={`flex items-center gap-3 rounded border p-3 cursor-pointer transition-colors ${
          enabled
            ? "border-[var(--moba-accent)]/40 bg-[var(--moba-accent)]/5"
            : "border-[var(--moba-divider)] bg-[var(--moba-bg)]"
        }`}
        onClick={onToggle}
      >
        <Terminal className={`w-4 h-4 shrink-0 ${enabled ? "text-[var(--moba-accent)]" : "text-[var(--moba-text-muted)]"}`} />
        <div className="flex-1">
          <div className="text-[13px] font-semibold">
            语音生成命令 <span className="text-[10px] text-yellow-400 ml-1">实验性</span>
          </div>
          <div className="text-[11px] text-[var(--moba-text-muted)]">
            用自然语言描述命令，AI 生成 shell 脚本并显示确认卡
          </div>
        </div>
        <div
          className={`w-9 h-5 rounded-full transition-colors relative ${
            enabled ? "bg-[var(--moba-accent)]" : "bg-[var(--moba-divider)]"
          }`}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </div>
      </div>

      {/* Demo input (only shown when enabled) */}
      {enabled && (
        <div className="space-y-2">
          <div className="text-[11px] text-[var(--moba-text-muted)]">
            测试：输入自然语言描述，生成命令预览卡
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              className="moba-input h-8 flex-1 text-[12px]"
              placeholder="例：列出当前目录所有大于 100MB 的文件"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
            />
            <button
              type="button"
              className="moba-btn h-8 px-3 text-[12px] inline-flex items-center gap-1.5 shrink-0"
              onClick={handleGenerate}
              disabled={loading || !description.trim()}
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "生成"}
            </button>
          </div>

          {error && (
            <div className="text-[11px] text-red-400 rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5">
              {error}
            </div>
          )}

          {preview && (
            <CommandPreviewCard
              preview={preview}
              onExecute={handleExecute}
              onCancel={handleCancel}
              onCopy={handleCopy}
            />
          )}
        </div>
      )}
    </div>
  );
}
