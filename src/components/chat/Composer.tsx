import { useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";

interface ComposerProps {
  onSend: (content: string, terminalContext?: string) => Promise<void>;
  sending: boolean;
  disabled?: boolean;
}

export function Composer({ onSend, sending, disabled }: ComposerProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setText("");
    await onSend(trimmed);
    textareaRef.current?.focus();
  };

  return (
    <div
      className="border-t border-[var(--moba-divider)] p-2"
      style={{ background: "var(--moba-panel-bg)" }}
    >
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          className="moba-input flex-1 text-[12px] resize-none min-h-[56px] max-h-[120px] py-1.5"
          placeholder="输入消息... (Ctrl+Enter 发送)"
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
          title="发送 (Ctrl+Enter)"
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
