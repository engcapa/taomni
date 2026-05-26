import { CheckCircle, Loader2, X, XCircle } from "lucide-react";
import { useT, type TranslateFn } from "../../lib/i18n";

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

function toolLabel(tool: string, t: TranslateFn): string {
  switch (tool) {
    case "list_sessions":      return t("agent.toolListSessions");
    case "search_history":     return t("agent.toolSearchHistory");
    case "run_in_terminal":    return t("agent.toolRunInTerminal");
    case "read_terminal_tail": return t("agent.toolReadTerminalTail");
    case "explain_error":      return t("agent.toolExplainError");
    default:                   return tool;
  }
}

export function ActionCard({
  tool,
  description,
  preview,
  requiresConfirmation,
  onDecide,
  executing = false,
}: ActionCardProps) {
  const t = useT();
  const label = toolLabel(tool, t);
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
          {t("agent.agentWants", { label })}
        </span>
        {isWrite && (
          <span className="text-[10px] text-yellow-400 border border-yellow-500/40 rounded px-1.5 py-0.5">
            {t("agent.writeBadge")}
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
              {t("agent.actionAllow")}
            </button>
            <button
              type="button"
              className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
              onClick={() => onDecide("allow-session")}
              title={t("agent.actionAllowSessionTitle")}
            >
              {t("agent.actionAllowSession")}
            </button>
            <button
              type="button"
              className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1.5 text-[var(--moba-text-muted)]"
              onClick={() => onDecide("deny")}
            >
              <XCircle className="w-3.5 h-3.5" />
              {t("agent.actionDeny")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
