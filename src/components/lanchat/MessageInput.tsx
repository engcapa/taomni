import { useState } from "react";
import { AtSign, Camera, Paperclip, Send, Smile } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";

/** Message composer. Phase 7 ships text send (Enter to send, Shift+Enter for a
 *  newline); @-mention autocomplete is added in phase 8 and file/screenshot in
 *  task 02. */
export function MessageInput({ disabled }: { disabled?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const sendCurrent = useLanChatStore((s) => s.sendCurrent);

  const send = async () => {
    const body = text.trim();
    if (!body || busy || disabled) return;
    setBusy(true);
    try {
      await sendCurrent(body);
      setText("");
    } catch {
      /* error surfaced via message state */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="px-2.5 py-2"
      style={{ borderTop: "1px solid var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
    >
      <div className="mb-1.5 flex gap-0.5">
        <ToolButton title="表情（即将支持）" disabled>
          <Smile className="h-4 w-4" />
        </ToolButton>
        <ToolButton title="@ 提及" disabled>
          <AtSign className="h-4 w-4" />
        </ToolButton>
        <ToolButton title="发送文件（任务 02）" disabled>
          <Paperclip className="h-4 w-4" />
        </ToolButton>
        <ToolButton title="截图（任务 02）" disabled>
          <Camera className="h-4 w-4" />
        </ToolButton>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={disabled ? "选择会话后输入消息…" : "输入消息，回车发送，Shift+回车换行…"}
          className="h-9 flex-1 resize-none rounded-lg px-2.5 py-2 text-[12px] outline-none"
          style={{
            border: "1px solid var(--taomni-input-border)",
            background: "var(--taomni-input-bg)",
            color: "var(--taomni-text)",
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={disabled || busy || !text.trim()}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-4 text-[12px] font-semibold text-white disabled:opacity-50"
          style={{
            background: "linear-gradient(to bottom,var(--taomni-accent-soft),var(--taomni-accent))",
            border: "1px solid var(--taomni-accent)",
          }}
        >
          <Send className="h-3.5 w-3.5" />
          发送
        </button>
      </div>
    </div>
  );
}

function ToolButton({
  title,
  disabled,
  children,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="grid h-6.5 w-7 place-items-center rounded-md disabled:opacity-40"
      style={{ color: "var(--taomni-text-muted)" }}
    >
      {children}
    </button>
  );
}
