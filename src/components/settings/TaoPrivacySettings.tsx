import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useLocale } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";

interface Summary { version: number; commandsCleaned: number; queriesCleaned: number }
const NAMES: Record<string, [string, string]> = {
  commands: ["命令历史", "Command history"], sql: ["SQL 历史", "SQL history"], queries: ["保存的查询", "Saved queries"],
  sessions: ["会话元数据", "Session metadata"], notes: ["笔记", "Notes"], tao: ["Tao 对话", "Tao chats"], legacy: ["旧对话", "Legacy chats"],
};

export function TaoPrivacySettings() {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sources, setSources] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    void Promise.all([invoke<Summary>("history_privacy_summary"), invoke<Record<string, boolean>>("deepseek_app_search_sources")]).then(([next, values]) => {
      if (!disposed) { setSummary(next); setSources(values); }
    }).catch((failure) => { if (!disposed) setError(String(failure)); });
    return () => { disposed = true; };
  }, []);
  const change = async (source: string, enabled: boolean) => {
    setSaving(true); setError("");
    try { await invoke("deepseek_app_set_search_sources", { sources: { [source]: enabled } }); setSources((current) => ({ ...current, [source]: enabled })); }
    catch (failure) { setError(String(failure)); }
    finally { setSaving(false); }
  };
  return <section className="space-y-2 border-t border-[var(--taomni-divider)] pt-3" data-testid="tao-settings-privacy">
    <h4>{zh ? "本地资料与清理状态" : "Local records and privacy cleanup"}</h4>
    {!isTauriRuntime() ? <p>{zh ? "本地索引和迁移状态需要桌面应用。" : "Local indexing and migration status require the desktop app."}</p> : null}
    {summary && <p data-testid="tao-privacy-summary">{zh ? `清理版本 ${summary.version}：命令 ${summary.commandsCleaned} 条，SQL ${summary.queriesCleaned} 条。` : `Cleanup version ${summary.version}: ${summary.commandsCleaned} commands, ${summary.queriesCleaned} SQL records.`}</p>}
    <p className="text-[11px]">{zh ? "关闭来源会立即清除其索引；重新启用时从已脱敏的原始记录重建。检索在本机完成。" : "Disabling a source clears its index immediately. Re-enabling rebuilds it from redacted records. Search stays on this device."}</p>
    <div className="flex flex-wrap gap-3">{Object.entries(sources).map(([source, enabled]) => <label key={source}><input type="checkbox" data-testid={`tao-search-source-${source}`} checked={enabled} disabled={saving} onChange={(event) => void change(source, event.target.checked)} /> {NAMES[source]?.[zh ? 0 : 1] ?? source}</label>)}</div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
