import { invoke } from "@tauri-apps/api/core";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLocale } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import { TaoPopover, useTaoPopover } from "../tao/ai-chat/Popover";

interface Summary { version: number; commandsCleaned: number; queriesCleaned: number }
const NAMES: Record<string, [string, string]> = {
  commands: ["命令历史", "Command history"], sql: ["SQL 历史", "SQL history"], queries: ["保存的查询", "Saved queries"],
  sessions: ["会话元数据", "Session metadata"], notes: ["笔记", "Notes"], tao: ["Tao 对话", "Tao chats"], legacy: ["旧对话", "Legacy chats"],
  bookmarks: ["SQL 书签", "SQL bookmarks"], groups: ["会话分组", "Session groups"], capabilities: ["功能与工具目录", "Features and tools"], memory: ["已启用记忆/技能", "Enabled memories/skills"], snapshots: ["文件快照元数据", "File snapshot metadata"],
  file_contents: ["文件快照内容（需授权）", "Snapshot contents (opt in)"], mail: ["邮件主题/发件人（需授权）", "Mail subjects/senders (opt in)"], mail_bodies: ["邮件/草稿正文（需授权）", "Mail/draft bodies (opt in)"], voice: ["语音转写（需授权）", "Voice transcripts (opt in)"],
};

export function TaoPrivacySettings() {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sources, setSources] = useState<Record<string, boolean> | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Set<string>());
  const popup = useTaoPopover();
  const listId = useId();
  const title = zh ? "本地检索来源" : "Local search sources";

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    void Promise.all([invoke<Summary>("history_privacy_summary"), invoke<Record<string, boolean>>("deepseek_app_search_sources")]).then(([next, values]) => {
      if (!disposed) { setSummary(next); setSources(values); }
    }).catch((failure) => { if (!disposed) setError(String(failure)); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (popup.open) popup.contentRef.current?.querySelector("input")?.focus();
  }, [popup.open, popup.contentRef]);

  const change = async (source: string, enabled: boolean) => {
    if (pending.current.has(source)) return;
    pending.current.add(source);
    setSaving(new Set(pending.current));
    setError("");
    try {
      await invoke("deepseek_app_set_search_sources", { sources: { [source]: enabled } });
      setSources((current) => ({ ...current, [source]: enabled }));
    } catch (failure) {
      setError(String(failure));
    } finally {
      pending.current.delete(source);
      setSaving(new Set(pending.current));
    }
  };

  const options = Object.entries(sources ?? {});
  const count = options.filter(([, enabled]) => enabled).length;
  return <section className="space-y-2 border-t border-[var(--taomni-divider)] pt-3" data-testid="tao-settings-privacy">
    <h4>{zh ? "本地资料与清理状态" : "Local records and privacy cleanup"}</h4>
    {!isTauriRuntime() ? <p>{zh ? "本地索引和迁移状态需要桌面应用。" : "Local indexing and migration status require the desktop app."}</p> : null}
    {summary && <p data-testid="tao-privacy-summary">{zh ? `清理版本 ${summary.version}：命令 ${summary.commandsCleaned} 条，SQL ${summary.queriesCleaned} 条。` : `Cleanup version ${summary.version}: ${summary.commandsCleaned} commands, ${summary.queriesCleaned} SQL records.`}</p>}
    <p className="text-[11px]">{zh ? "关闭来源会立即清除其索引；重新启用时从已脱敏的原始记录重建。检索在本机完成。" : "Disabling a source clears its index immediately. Re-enabling rebuilds it from redacted records. Search stays on this device."}</p>
    {sources && <>
      <button type="button" ref={popup.triggerRef} className="taomni-btn flex min-h-8 items-center gap-2 px-3"
        data-testid="tao-search-sources" aria-haspopup="dialog" aria-expanded={popup.open}
        aria-controls={popup.open ? listId : undefined} onClick={() => popup.setOpen(!popup.open)}>
        {title}<span className="text-[var(--taomni-text-muted)]">{count}/{options.length}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <TaoPopover owner={popup} label={title}>
        <div id={listId} data-testid="tao-search-sources-menu" className="max-h-[min(320px,60vh)] min-w-56 overflow-y-auto p-2"
          aria-busy={saving.size > 0 || undefined}>
          {options.map(([source, enabled]) => (
            <label key={source} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--taomni-hover)]">
              <input type="checkbox" data-testid={`tao-search-source-${source}`} checked={enabled}
                aria-disabled={saving.has(source) || undefined} onChange={(event) => void change(source, event.target.checked)} />
              {NAMES[source]?.[zh ? 0 : 1] ?? source}
            </label>
          ))}
          {error && <p role="alert">{error}</p>}
        </div>
      </TaoPopover>
    </>}
    {error && !popup.open && <p role="alert">{error}</p>}
  </section>;
}
