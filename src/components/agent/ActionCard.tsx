import { CheckCircle, Loader2, X, XCircle } from "lucide-react";

export type ActionCardDecision = "allow" | "allow-session" | "deny";

export interface ActionCardProps {
  /** Tool name being called. */
  tool: string;
  /** Human-readable description of what the tool will do. */
  description: string;
  /** Optional dry-run preview (e.g. the command that would be executed). */
  preview?: string | null;
  /** Whether this is a write action requiring explicit confirmation. */
  requiresConfirmation: boolean;
  /** Called when user makes a decision. */
  onDecide: (decision: ActionCardDecision) => void;
  /** Whether the action is currently executing. */
  executing?: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  list_sessions:      "列出会话",
  search_history:     "搜索历史",
  run_in_terminal:    "执行命令",
  read_terminal_tail: "读取终端输出",
  explain_error:      "分析错误",
};

export function ActionCard({
  tool,
  description,
  preview,
  requiresConfirmation,
  onDecide,
  executing = false,
}: ActionCardProps) {
  const label = TOOL_LABELS[tool] ?? tool;
  const isWrite = requiresConfirmation;

  return (
    <div
      className={`rounded-lg border p-3 shadow-md max-w-md w-full ${
        isWrite
          ? "border-yellow-500/40 bg-yellow-500/5"
          : "border-[var(--moba-divider)] bg-[var(--moba-panel-bg)]"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[12px] font-semibold">
          Agent 想要：{label}
        </span>
        {isWrite && (
          <span className="text-[10px] text-yellow-400 border border-yellow-500/40 rounded px-1.5 py-0.5">
            写操作
          </span>
        )}
        <button
          type="button"
          className="ml-auto text-[var(--moba-text-muted)] hover:text-[var(--moba-text)]"
          onClick={() => onDecide("deny")}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="text-[11px] text-[var(--moba-text-muted)] mb-2">{description}</div>

      {preview && (
        <pre className="font-mono text-[11px] bg-[var(--moba-bg)] rounded px-2 py-1.5 mb-2 overflow-x-auto whitespace-pre-wrap break-all">
          {preview}
        </pre>
      )}

      <div className="flex items-center gap-2">
        {executing ? (
          <Loader2 className="w-4 h-4 animate-spin text-[var(--moba-accent)]" />
        ) : (
          <>
            <button
              type="button"
              className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
              onClick={() => onDecide("allow")}
            >
              <CheckCircle className="w-3.5 h-3.5" />
              允许
            </button>
            <button
              type="button"
              className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
              onClick={() => onDecide("allow-session")}
              title="本会话内不再询问此工具"
            >
              本会话允许
            </button>
            <button
              type="button"
              className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5 text-[var(--moba-text-muted)]"
              onClick={() => onDecide("deny")}
            >
              <XCircle className="w-3.5 h-3.5" />
              拒绝
            </button>
          </>
        )}
      </div>
    </div>
  );
}
