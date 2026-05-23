import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Globe, Loader2 } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";

const CONFIRM_MODE_OPTIONS = [
  { value: "per_call",    label: "每次确认（默认）",          desc: "每次搜索都弹确认卡" },
  { value: "per_thread",  label: "首次确认 + 本 thread 静默", desc: "同 thread 后续搜索不再弹卡" },
  { value: "always",      label: "总是允许",                  desc: "不弹卡，但 Drawer 中仍显示搜索提示" },
  { value: "disabled",    label: "完全禁用",                  desc: "Agent 看不到搜索工具" },
] as const;

const PROVIDER_OPTIONS = [
  { value: "searxng", label: "SearXNG（默认，无需 API Key）" },
  { value: "tavily",  label: "Tavily（1k/月免费，英文优秀）" },
  { value: "serper",  label: "Serper（Google 索引，中文优秀）" },
] as const;

export function WebSearchPanel() {
  const { config, loadConfig, saveConfig } = useAiStore();
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);

  useEffect(() => {
    if (!config) loadConfig();
  }, []);

  if (!config) return <div className="text-[12px] text-[var(--moba-text-muted)]">加载中...</div>;

  const ws = config.web_search;

  const update = async (patch: Partial<typeof ws>) => {
    const newConfig = { ...config, web_search: { ...ws, ...patch } };
    await saveConfig(newConfig);
  };

  const handleProbe = async () => {
    setProbing(true);
    setProbeResult(null);
    try {
      const best = await invoke<string | null>("probe_searxng_instances");
      setProbeResult(best ?? "所有公共实例均不可达，请自填 URL");
    } catch (e) {
      setProbeResult(`探测失败: ${String(e)}`);
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold">Web Search</div>
        <div className="text-[11px] text-[var(--moba-text-muted)]">
          Agent 联网搜索能力 · 默认关闭 · 每次搜索必须用户确认
        </div>
      </div>

      {/* Enable toggle */}
      <div
        className={`flex items-center gap-3 rounded border p-3 cursor-pointer transition-colors ${
          ws.client_enabled
            ? "border-[var(--moba-accent)]/40 bg-[var(--moba-accent)]/5"
            : "border-[var(--moba-divider)] bg-[var(--moba-bg)]"
        }`}
        onClick={() => update({ client_enabled: !ws.client_enabled })}
      >
        <Globe className={`w-4 h-4 shrink-0 ${ws.client_enabled ? "text-[var(--moba-accent)]" : "text-[var(--moba-text-muted)]"}`} />
        <div className="flex-1">
          <div className="text-[13px] font-semibold">启用客户端 Web Search</div>
          <div className="text-[11px] text-[var(--moba-text-muted)]">
            开启后 Agent 可搜索网络（每次需用户确认）
          </div>
        </div>
        <div className={`w-9 h-5 rounded-full transition-colors relative ${ws.client_enabled ? "bg-[var(--moba-accent)]" : "bg-[var(--moba-divider)]"}`}>
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${ws.client_enabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </div>
      </div>

      {ws.client_enabled && (
        <>
          {/* Provider selection */}
          <div>
            <div className="text-[11px] text-[var(--moba-text-muted)] mb-1.5">搜索提供方</div>
            <div className="space-y-1">
              {PROVIDER_OPTIONS.map(({ value, label }) => (
                <label key={value} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="ws-provider"
                    value={value}
                    checked={ws.client_provider === value}
                    onChange={() => update({ client_provider: value })}
                    className="accent-[var(--moba-accent)]"
                  />
                  <span className="text-[12px]">{label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* SearXNG URL */}
          {ws.client_provider === "searxng" && (
            <div>
              <div className="text-[11px] text-[var(--moba-text-muted)] mb-1">SearXNG 实例 URL（留空自动探测）</div>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="moba-input h-7 flex-1 text-[12px]"
                  placeholder="https://searx.be"
                  value={ws.searxng_url ?? ""}
                  onChange={(e) => update({ searxng_url: e.target.value || undefined })}
                />
                <button
                  type="button"
                  className="moba-btn h-7 px-2 text-[11px] inline-flex items-center gap-1 shrink-0"
                  onClick={handleProbe}
                  disabled={probing}
                >
                  {probing ? <Loader2 className="w-3 h-3 animate-spin" /> : "探测最快实例"}
                </button>
              </div>
              {probeResult && (
                <div className="text-[11px] text-green-400 mt-1">{probeResult}</div>
              )}
            </div>
          )}

          {/* BYOK key for Tavily/Serper */}
          {(ws.client_provider === "tavily" || ws.client_provider === "serper") && (
            <div>
              <div className="text-[11px] text-[var(--moba-text-muted)] mb-1">
                {ws.client_provider === "tavily" ? "Tavily" : "Serper"} API Key
              </div>
              <input
                type="password"
                className="moba-input h-7 w-full text-[12px]"
                placeholder="粘贴 API Key..."
                value={ws.byok_key}
                onChange={(e) => update({ byok_key: e.target.value })}
              />
            </div>
          )}

          {/* Confirmation mode */}
          <div>
            <div className="text-[11px] text-[var(--moba-text-muted)] mb-1.5">确认模式</div>
            <div className="space-y-1">
              {CONFIRM_MODE_OPTIONS.map(({ value, label, desc }) => (
                <label key={value} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="ws-confirm"
                    value={value}
                    checked={ws.confirm_mode === value}
                    onChange={() => update({ confirm_mode: value })}
                    className="mt-0.5 accent-[var(--moba-accent)]"
                  />
                  <div>
                    <div className="text-[12px]">{label}</div>
                    <div className="text-[10px] text-[var(--moba-text-muted)]">{desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
