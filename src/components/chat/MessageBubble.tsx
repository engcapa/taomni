import type { ChatMessage } from "../../stores/chatStore";
import { ShieldAlert } from "lucide-react";

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[90%] rounded-lg px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words ${
          isUser
            ? "bg-[var(--moba-accent)] text-white rounded-br-sm"
            : "bg-[var(--moba-panel-bg)] border border-[var(--moba-divider)] rounded-bl-sm"
        }`}
      >
        {message.content}
      </div>
      {message.redacted && (
        <div className="flex items-center gap-1 text-[10px] text-yellow-500">
          <ShieldAlert className="w-3 h-3" />
          已脱敏敏感字段
        </div>
      )}
    </div>
  );
}
