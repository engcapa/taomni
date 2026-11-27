import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Wand2 } from "lucide-react";
import { VAULT_LOCKED_EVENT, isVaultLockedError } from "../../lib/ipc";
import { DictationButton } from "../voice/DictationButton";
import { useT } from "../../lib/i18n";

interface AiRewriteOverlayProps {
  currentCommand: string;
  onAccept: (newCommand: string) => void;
  onDismiss: () => void;
}

/**
 * Small overlay triggered by Ctrl+K.
 * User types a natural language instruction; AI rewrites the current command.
 * Shows a diff (old → new) before accepting.
 */
export function AiRewriteOverlay({ currentCommand, onAccept, onDismiss }: AiRewriteOverlayProps) {
  const [instruction, setInstruction] = useState("");
  const [rewritten, setRewritten] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onDismiss(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDismiss]);

  const handleRewrite = async () => {
    if (!instruction.trim()) return;
    setLoading(true);
    setError(null);
    setRewritten(null);
    try {
      // Dedicated rewrite path (TaskKind::CommandRewrite, cloud by default).
      const newCmd = await invoke<string>("tab_rewrite_command", {
        currentCommand,
        instruction,
      });
      setRewritten(newCmd);
    } catch (e) {
      if (isVaultLockedError(e)) {
        window.dispatchEvent(
          new CustomEvent(VAULT_LOCKED_EVENT, {
            detail: {
              reason: t("terminal.aiRewriteVaultLockedDetail"),
            },
          }),
        );
        setError(t("terminal.aiRewriteVaultLockedError"));
      } else {
        setError(String(e));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = () => {
    if (rewritten !== null) onAccept(rewritten);
  };

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 mx-2 rounded-lg border border-[var(--taomni-accent)]/40 bg-[var(--taomni-panel-bg)] shadow-xl p-3 z-[var(--taomni-z-popover)]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 mb-2">
        <Wand2 className="w-3.5 h-3.5 text-[var(--taomni-accent)] shrink-0" />
        <span className="text-ui-body font-semibold">{t("terminal.aiRewriteHeading")}</span>
        <span className="text-ui-small text-[var(--taomni-text-muted)] ml-auto">{t("terminal.aiRewriteEscHint")}</span>
      </div>

      {/* Current command */}
      <div className="mb-2 font-mono text-ui-small bg-[var(--taomni-bg)] rounded px-2 py-1 text-[var(--taomni-text-muted)] truncate">
        {currentCommand || <span className="italic">{t("terminal.aiRewriteEmpty")}</span>}
      </div>

      {/* Instruction input */}
      <div className="flex gap-2 mb-2">
        <DictationButton targetRef={inputRef} onText={setInstruction} contextKey={currentCommand} disabled={loading} testId="rewrite-voice-button" />
        <input
          ref={inputRef}
          type="text"
          className="taomni-input h-7 flex-1 text-ui-body"
          placeholder={t("terminal.aiRewritePlaceholder")}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); handleRewrite(); }
          }}
        />
        <button
          type="button"
          className="taomni-btn h-7 px-3 text-ui-body inline-flex items-center gap-1 shrink-0"
          onClick={handleRewrite}
          disabled={loading || !instruction.trim()}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("terminal.aiRewriteApply")}
        </button>
      </div>

      {error && (
        <div className="text-ui-small text-ui-danger mb-2">{error}</div>
      )}

      {/* Diff display */}
      {rewritten !== null && (
        <div className="space-y-1 mb-2">
          <div className="font-mono text-ui-small bg-ui-danger-surface border border-ui-danger-border rounded px-2 py-1 line-through text-[var(--taomni-text-muted)]">
            {currentCommand}
          </div>
          <div className="font-mono text-ui-small bg-ui-success-surface border border-ui-success-border rounded px-2 py-1 text-ui-success">
            {rewritten}
          </div>
        </div>
      )}

      {/* Accept / dismiss */}
      {rewritten !== null && (
        <div className="flex gap-2">
          <button
            type="button"
            className="taomni-btn h-7 px-3 text-ui-body"
            onClick={handleAccept}
          >
            {t("terminal.aiRewriteAccept")}
          </button>
          <button
            type="button"
            className="taomni-btn h-7 px-3 text-ui-body text-[var(--taomni-text-muted)]"
            onClick={onDismiss}
          >
            {t("terminal.aiRewriteCancel")}
          </button>
        </div>
      )}
    </div>
  );
}
