import { Clock, Plus, Trash2 } from "lucide-react";
import type { ChatThread } from "../../stores/chatStore";
import { useT, type TranslateFn } from "../../lib/i18n";

interface ChatThreadListProps {
  threads: ChatThread[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onDelete: (threadId: string) => void;
}

function formatTime(ts: number, t: TranslateFn): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return t("chat.timeYesterday");
  if (diffDays < 7) return t("chat.timeDaysAgo", { days: diffDays });
  return d.toLocaleDateString();
}

export function ChatThreadList({ threads, activeThreadId, onSelect, onNew, onDelete }: ChatThreadListProps) {
  const t = useT();
  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--taomni-divider)]"
        style={{ background: "var(--taomni-panel-bg)" }}
      >
        <Clock className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
        <span className="text-[12px] font-semibold flex-1">{t("chat.threadListTitle")}</span>
        <button
          type="button"
          className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          onClick={onNew}
          title={t("chat.threadNewTitle")}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {threads.length === 0 && (
          <div className="text-[11px] text-[var(--taomni-text-muted)] text-center py-4">
            {t("chat.threadEmptyState")}
          </div>
        )}
        {threads.map((th) => (
          <div
            key={th.id}
            className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer group transition-colors ${
              th.id === activeThreadId
                ? "bg-[var(--taomni-selected)] border-l-2 border-[var(--taomni-accent)]"
                : "hover:bg-[var(--taomni-hover)]"
            }`}
            onClick={() => onSelect(th.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="text-[12px] truncate">{th.title}</div>
              <div className="text-[10px] text-[var(--taomni-text-muted)]">
                {th.provider_id} · {formatTime(th.updated_at, t)}
              </div>
            </div>
            <button
              type="button"
              className="opacity-0 group-hover:opacity-100 h-5 w-5 p-0 inline-flex items-center justify-center rounded hover:bg-red-500/20 hover:text-red-400 transition-all"
              onClick={(e) => { e.stopPropagation(); onDelete(th.id); }}
              title={t("chat.threadDeleteTitle")}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
