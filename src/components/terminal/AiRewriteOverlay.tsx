import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Wand2 } from "lucide-react";
import { VAULT_LOCKED_EVENT, isVaultLockedError } from "../../lib/ipc";
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
      className="absolute bottom-full left-0 right-0 mb-1 mx-2 rounded-lg border border-[var(--moba-accent)]/40 bg-[var(--moba-panel-bg)] shadow-xl p-3 z-[300]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 mb-2">
        <Wand2 className="w-3.5 h-3.5 text-[var(--moba-accent)] shrink-0" />
        <span className="text-[12px] font-semibold">{t("terminal.aiRewriteHeading")}</span>
        <span className="text-[11px] text-[var(--moba-text-muted)] ml-auto">{t("terminal.aiRewriteEscHint")}</span>
      </div>

      {/* Current command */}
      <div className="mb-2 font-mono text-[11px] bg-[var(--moba-bg)] rounded px-2 py-1 text-[var(--moba-text-muted)] truncate">
        {currentCommand || <span className="italic">{t("terminal.aiRewriteEmpty")}</span>}
      </div>

      {/* Instruction input */}
      <div className="flex gap-2 mb-2">
        <input
          ref={inputRef}
          type="text"
          className="moba-input h-7 flex-1 text-[12px]"
          placeholder={t("terminal.aiRewritePlaceholder")}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); handleRewrite(); }
          }}
        />
        <button
          type="button"
          className="moba-btn h-7 px-3 text-[12px] inline-flex items-center gap-1 shrink-0"
          onClick={handleRewrite}
          disabled={loading || !instruction.trim()}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t("terminal.aiRewriteApply")}
        </button>
      </div>

      {error && (
        <div className="text-[11px] text-red-400 mb-2">{error}</div>
      )}

      {/* Diff display */}
      {rewritten !== null && (
        <div className="space-y-1 mb-2">
          <div className="font-mono text-[11px] bg-red-500/10 border border-red-500/20 rounded px-2 py-1 line-through text-[var(--moba-text-muted)]">
            {currentCommand}
          </div>
          <div className="font-mono text-[11px] bg-green-500/10 border border-green-500/20 rounded px-2 py-1 text-green-300">
            {rewritten}
          </div>
        </div>
      )}

      {/* Accept / dismiss */}
      {rewritten !== null && (
        <div className="flex gap-2">
          <button
            type="button"
            className="moba-btn h-7 px-3 text-[12px]"
            onClick={handleAccept}
          >
            {t("terminal.aiRewriteAccept")}
          </button>
          <button
            type="button"
            className="moba-btn h-7 px-3 text-[12px] text-[var(--moba-text-muted)]"
            onClick={onDismiss}
          >
            {t("terminal.aiRewriteCancel")}
          </button>
        </div>
      )}
    </div>
  );
}
