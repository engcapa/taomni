import { Clock, Plus, Trash2 } from "lucide-react";
import type { ChatThread } from "../../stores/chatStore";

interface ChatThreadListProps {
  threads: ChatThread[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onDelete: (threadId: string) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays}天前`;
  return d.toLocaleDateString();
}

export function ChatThreadList({ threads, activeThreadId, onSelect, onNew, onDelete }: ChatThreadListProps) {
  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--moba-divider)]"
        style={{ background: "var(--moba-panel-bg)" }}
      >
        <Clock className="w-3.5 h-3.5 text-[var(--moba-text-muted)]" />
        <span className="text-[12px] font-semibold flex-1">历史对话</span>
        <button
          type="button"
          className="moba-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          onClick={onNew}
          title="新对话"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {threads.length === 0 && (
          <div className="text-[11px] text-[var(--moba-text-muted)] text-center py-4">
            暂无对话记录
          </div>
        )}
        {threads.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer group transition-colors ${
              t.id === activeThreadId
                ? "bg-[var(--moba-selected)] border-l-2 border-[var(--moba-accent)]"
                : "hover:bg-[var(--moba-hover)]"
            }`}
            onClick={() => onSelect(t.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="text-[12px] truncate">{t.title}</div>
              <div className="text-[10px] text-[var(--moba-text-muted)]">
                {t.provider_id} · {formatTime(t.updated_at)}
              </div>
            </div>
            <button
              type="button"
              className="opacity-0 group-hover:opacity-100 h-5 w-5 p-0 inline-flex items-center justify-center rounded hover:bg-red-500/20 hover:text-red-400 transition-all"
              onClick={(e) => { e.stopPropagation(); onDelete(t.id); }}
              title="删除对话"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
