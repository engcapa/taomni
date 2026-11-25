import { IconButton } from "../ui/IconButton";
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
      className={`rounded-lg border p-3 shadow-md max-w-md w-full bg-[var(--taomni-panel-bg)] ${
        isWrite
          ? "border-yellow-500/50"
          : "border-[var(--taomni-divider)]"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-ui-body font-semibold">
          {t("agent.agentWants", { label })}
        </span>
        {isWrite && (
          <span className="text-ui-caption text-yellow-400 border border-yellow-500/40 rounded px-1.5 py-0.5">
            {t("agent.writeBadge")}
          </span>
        )}
        <IconButton labelKey="denyRequest"
          type="button"
          className="ml-auto text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
          onClick={() => onDecide("deny")}
        >
          <X className="w-3.5 h-3.5" />
        </IconButton>
      </div>

      <div className="text-ui-small text-[var(--taomni-text-muted)] mb-2">{description}</div>

      {preview && (
        <pre className="font-mono text-ui-small bg-[var(--taomni-bg)] rounded px-2 py-1.5 mb-2 overflow-x-auto whitespace-pre-wrap break-all">
          {preview}
        </pre>
      )}

      <div className="flex items-center gap-2">
        {executing ? (
          <Loader2 className="w-4 h-4 animate-spin text-[var(--taomni-accent)]" />
        ) : (
          <>
            <button
              type="button"
              className="taomni-btn h-7 px-3 text-ui-body inline-flex items-center gap-1.5"
              data-testid="ai-chat-cc-permission-allow"
              onClick={() => onDecide("allow")}
            >
              <CheckCircle className="w-3.5 h-3.5" />
              {t("agent.actionAllow")}
            </button>
            <button
              type="button"
              className="taomni-btn h-7 px-3 text-ui-body inline-flex items-center gap-1.5"
              data-testid="ai-chat-cc-permission-allow-session"
              onClick={() => onDecide("allow-session")}
              title={t("agent.actionAllowSessionTitle")}
            >
              {t("agent.actionAllowSession")}
            </button>
            <button
              type="button"
              className="taomni-btn h-7 px-3 text-ui-body inline-flex items-center gap-1.5 text-[var(--taomni-text-muted)]"
              data-testid="ai-chat-cc-permission-deny"
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
