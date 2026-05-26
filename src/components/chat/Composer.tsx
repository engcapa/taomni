import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { parseComposerInput, type AttachmentRef } from "../../lib/chat/composerRefs";
import { AttachmentChip } from "./AttachmentChip";
import { useT } from "../../lib/i18n";

interface ComposerProps {
  onSend: (content: string, terminalContext?: string) => Promise<void>;
  sending: boolean;
  disabled?: boolean;
  /**
   * Optional resolver: turns AttachmentRefs into LLM-ready text before send.
   * Currently only `terminal` refs surface to the existing terminal_context
   * field — file/session refs are previewed as chips but not resolved on
   * the client (this PR keeps the round-trip surface small).
   */
  resolveTerminalContext?: (lines: number) => string | undefined;
}

export function Composer({ onSend, sending, disabled, resolveTerminalContext }: ComposerProps) {
  const t = useT();
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pending = useChatStore((s) => s.pendingComposerText);
  const consumePending = useChatStore((s) => s.consumePendingComposerText);

  // Pick up text staged by the SelectionToolbar's "Send to AI".
  useEffect(() => {
    if (pending && pending.length > 0) {
      setText((cur) => (cur ? `${cur}\n\n${pending}` : pending));
      consumePending();
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [pending, consumePending]);

  // Live parse @-references so we can show chips and remove them.
  const parsed = useMemo(() => parseComposerInput(text), [text]);
  const attachments: AttachmentRef[] = parsed.attachments;

  const handleRemove = (index: number) => {
    // Reconstruct text by stripping the n-th @-token. Simple: re-build from
    // the parsed message + remaining attachments rendered as their original
    // tokens. We don't try to preserve exact whitespace.
    const remaining = attachments.filter((_, i) => i !== index);
    const tokens = remaining.map(refToToken).join(" ");
    setText(tokens ? `${parsed.message} ${tokens}`.trim() : parsed.message);
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    // Resolve terminal references to terminal_context. Multiple @terminal
    // refs are merged; we take the largest line count.
    let terminalCtx: string | undefined;
    if (resolveTerminalContext) {
      const maxLines = attachments
        .filter((a) => a.kind === "terminal")
        .reduce((m, a) => (a.kind === "terminal" ? Math.max(m, a.lines) : m), 0);
      if (maxLines > 0) {
        terminalCtx = resolveTerminalContext(maxLines);
      }
    }

    setText("");
    await onSend(trimmed, terminalCtx);
    textareaRef.current?.focus();
  };

  return (
    <div
      className="border-t border-[var(--moba-divider)] p-2"
      style={{ background: "var(--moba-panel-bg)" }}
    >
      {attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {attachments.map((att, i) => (
            <AttachmentChip key={i} attachment={att} onRemove={() => handleRemove(i)} />
          ))}
        </div>
      )}
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          className="moba-input flex-1 text-[12px] resize-none min-h-[56px] max-h-[120px] py-1.5"
          placeholder={t("chat.inputPlaceholder")}
          value={text}
          disabled={disabled || sending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <button
          type="button"
          className="moba-btn h-8 w-8 p-0 inline-flex items-center justify-center shrink-0"
          onClick={handleSend}
          disabled={!text.trim() || sending || disabled}
          title={t("chat.sendShortcutTitle")}
        >
          {sending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Send className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function refToToken(ref: AttachmentRef): string {
  if (ref.kind === "terminal") return `@terminal:last-${ref.lines}`;
  if (ref.kind === "file") return `@file:${ref.path}`;
  return `@session:${ref.query}`;
}
