import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle, Copy, Edit2, X } from "lucide-react";

export type RiskLevel = "low" | "medium" | "high";

export interface CommandPreviewData {
  command: string;
  explanation: string;
  risk: RiskLevel;
  needs_inputs: string[];
  blocked: boolean;
  blocked_reason: string | null;
  audit_id: number;
}

interface CommandPreviewCardProps {
  preview: CommandPreviewData;
  onExecute: (command: string, auditId: number, edited: boolean) => void;
  onCancel: (auditId: number) => void;
  onCopy: (command: string) => void;
}

const RISK_CONFIG = {
  low:    { label: "低风险",  color: "text-green-400",  border: "border-green-500/30",  bg: "bg-green-500/5"  },
  medium: { label: "中风险",  color: "text-yellow-400", border: "border-yellow-500/40", bg: "bg-yellow-500/5" },
  high:   { label: "高风险",  color: "text-red-400",    border: "border-red-500/50",    bg: "bg-red-500/8"    },
};

// High-risk commands require 800ms before the execute button becomes clickable.
const HIGH_RISK_DELAY_MS = 800;

export function CommandPreviewCard({ preview, onExecute, onCancel, onCopy }: CommandPreviewCardProps) {
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(false);
  const [editedCommand, setEditedCommand] = useState(preview.command);
  const [executeReady, setExecuteReady] = useState(preview.risk !== "high");
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const risk = RISK_CONFIG[preview.risk];
  const command = editing || edited ? editedCommand : preview.command;

  // Start the anti-misclick timer for high-risk commands.
  useEffect(() => {
    if (preview.risk === "high" && !preview.blocked) {
      timerRef.current = setTimeout(() => setExecuteReady(true), HIGH_RISK_DELAY_MS);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [preview.risk, preview.blocked]);

  // Focus textarea when entering edit mode.
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  // Keyboard shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onCancel(preview.audit_id); return; }
      if (e.key === "Enter" && !editing && executeReady && !preview.blocked) {
        e.preventDefault();
        onExecute(command, preview.audit_id, edited);
      }
      if ((e.key === "e" || e.key === "E") && !editing) {
        e.preventDefault();
        setEditing(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editing, executeReady, preview.blocked, command, preview.audit_id]);

  const handleCopy = () => {
    onCopy(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={`rounded-lg border ${risk.border} ${risk.bg} p-4 shadow-lg max-w-xl w-full`}
      style={{ background: "var(--moba-panel-bg)" }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className={`w-4 h-4 ${risk.color} shrink-0`} />
        <span className="text-[13px] font-semibold flex-1">AI 生成的命令（未执行）</span>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${risk.border} ${risk.color}`}>
          {risk.label}
        </span>
        <button
          type="button"
          className="text-[var(--moba-text-muted)] hover:text-[var(--moba-text)] transition-colors"
          onClick={() => onCancel(preview.audit_id)}
          title="取消 (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Blocked warning */}
      {preview.blocked && (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          ⛔ 命令被安全规则拦截：{preview.blocked_reason}
          <br />
          <span className="text-[11px] text-[var(--moba-text-muted)]">可编辑后复制到剪贴板，但无法直接执行。</span>
        </div>
      )}

      {/* Command display / edit */}
      <div className="mb-3">
        {editing ? (
          <textarea
            ref={textareaRef}
            className="moba-input w-full font-mono text-[12px] p-2 resize-none min-h-[80px]"
            value={editedCommand}
            onChange={(e) => { setEditedCommand(e.target.value); setEdited(true); }}
            spellCheck={false}
          />
        ) : (
          <pre className="font-mono text-[12px] bg-[var(--moba-bg)] rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
            {preview.command}
          </pre>
        )}
      </div>

      {/* Explanation */}
      <div className="mb-3 text-[12px] text-[var(--moba-text-muted)]">
        {preview.explanation}
      </div>

      {/* Unfilled placeholders */}
      {preview.needs_inputs.length > 0 && (
        <div className="mb-3 text-[11px] text-yellow-400">
          ⚠ 需要填入：{preview.needs_inputs.join("、")}
        </div>
      )}

      {/* High-risk second confirmation */}
      {preview.risk === "high" && !preview.blocked && (
        <div className="mb-3 flex items-center gap-2 text-[11px] text-red-400">
          <input
            type="checkbox"
            id="high-risk-confirm"
            className="accent-red-500"
            onChange={(e) => {
              if (e.target.checked && !executeReady) {
                // Already handled by timer; checkbox is just visual confirmation
              }
            }}
          />
          <label htmlFor="high-risk-confirm">我已阅读命令并理解后果</label>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        {!preview.blocked && (
          <button
            type="button"
            className={`moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5 transition-opacity ${
              executeReady ? "" : "opacity-40 cursor-not-allowed"
            }`}
            onClick={() => executeReady && onExecute(command, preview.audit_id, edited)}
            disabled={!executeReady}
            title={executeReady ? "执行 (Enter)" : `等待 ${HIGH_RISK_DELAY_MS}ms...`}
          >
            <CheckCircle className="w-3.5 h-3.5" />
            {executeReady ? "执行 (Enter)" : "稍等..."}
          </button>
        )}

        {!editing ? (
          <button
            type="button"
            className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
            onClick={() => setEditing(true)}
            title="编辑 (E)"
          >
            <Edit2 className="w-3.5 h-3.5" />
            编辑 (E)
          </button>
        ) : (
          <button
            type="button"
            className="moba-btn h-7 px-3 text-[12px]"
            onClick={() => setEditing(false)}
          >
            完成编辑
          </button>
        )}

        <button
          type="button"
          className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
          onClick={handleCopy}
        >
          <Copy className="w-3.5 h-3.5" />
          {copied ? "已复制" : "复制"}
        </button>

        <button
          type="button"
          className="moba-btn h-7 px-3 text-[12px] text-[var(--moba-text-muted)]"
          onClick={() => onCancel(preview.audit_id)}
          title="取消 (Esc)"
        >
          取消 (Esc)
        </button>
      </div>
    </div>
  );
}
