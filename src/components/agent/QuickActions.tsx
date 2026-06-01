import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Loader2, Sparkles, Terminal } from "lucide-react";
import { ActionCard, type ActionCardDecision } from "./ActionCard";
import { useT } from "../../lib/i18n";

interface QuickActionsProps {
  /** The terminal session ID. */
  sessionId: string;
  /** Last N lines of terminal output (for "explain error"). */
  terminalContent: string;
  /** Whether the last command exited with a non-zero code. */
  hasError: boolean;
  /** Called with the AI explanation text. */
  onExplanation: (text: string) => void;
}

interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  dry_run_preview: string | null;
  requires_confirmation: boolean;
}

/**
 * Three fixed AI quick-action entry points shown near the terminal status bar.
 * Only visible when hasError=true (for "explain error") or always (for others).
 */
export function QuickActions({ sessionId, terminalContent, hasError, onExplanation }: QuickActionsProps) {
  const t = useT();
  const [loading, setLoading] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [sessionAllowedTools, setSessionAllowedTools] = useState<Set<string>>(new Set());

  const handleExplainError = async () => {
    if (!terminalContent.trim()) return;
    setLoading("explain");
    try {
      const explanation = await invoke<string>("agent_explain_error", {
        terminalContent,
        sessionId,
      });
      onExplanation(explanation);
    } catch (e) {
      onExplanation(t("agent.explainErrorPrefix", { error: String(e) }));
    } finally {
      setLoading(null);
    }
  };

  const handlePlanTool = async (request: string, loadingKey: string) => {
    setLoading(loadingKey);
    try {
      const action = await invoke<PendingAction | null>("agent_plan_tool", { request });
      if (action) {
        // If this tool is session-allowed, execute immediately.
        if (sessionAllowedTools.has(action.tool) || !action.requires_confirmation) {
          await executeAction(action);
        } else {
          setPendingAction(action);
        }
      }
    } catch (e) {
      console.error("agent_plan_tool failed:", e);
    } finally {
      setLoading(null);
    }
  };

  const executeAction = async (action: PendingAction) => {
    try {
      await invoke("agent_execute_tool", { tool: action.tool, args: action.args });
    } catch (e) {
      console.error("agent_execute_tool failed:", e);
    }
    setPendingAction(null);
  };

  const handleDecide = async (decision: ActionCardDecision) => {
    if (!pendingAction) return;
    if (decision === "allow" || decision === "allow-session") {
      if (decision === "allow-session") {
        setSessionAllowedTools((s) => new Set([...s, pendingAction.tool]));
      }
      await executeAction(pendingAction);
    } else {
      setPendingAction(null);
    }
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {hasError && (
        <button
          type="button"
          className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1 text-yellow-400 border-yellow-500/30"
          onClick={handleExplainError}
          disabled={loading === "explain"}
          title={t("agent.explainErrorTitle")}
        >
          {loading === "explain" ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Bot className="w-3 h-3" />
          )}
          {t("agent.explainError")}
        </button>
      )}

      <button
        type="button"
        className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
        onClick={() => handlePlanTool(t("agent.planRequestList"), "sessions")}
        disabled={!!loading}
        title={t("agent.listSessionsTitle")}
      >
        {loading === "sessions" ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Terminal className="w-3 h-3" />
        )}
        {t("agent.listSessions")}
      </button>

      <button
        type="button"
        className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
        onClick={() => handlePlanTool(t("agent.planRequestHistory"), "history")}
        disabled={!!loading}
        title={t("agent.findHistoryTitle")}
      >
        {loading === "history" ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Sparkles className="w-3 h-3" />
        )}
        {t("agent.findHistory")}
      </button>

      {pendingAction && (
        <div className="absolute bottom-full left-0 mb-2 z-[400]">
          <ActionCard
            tool={pendingAction.tool}
            description={t("chat.agentWantsExecute", { tool: pendingAction.tool })}
            preview={pendingAction.dry_run_preview}
            requiresConfirmation={pendingAction.requires_confirmation}
            onDecide={handleDecide}
          />
        </div>
      )}
    </div>
  );
}
