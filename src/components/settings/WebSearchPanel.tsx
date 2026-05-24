import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Globe, Loader2 } from "lucide-react";
import { useAiStore } from "../../stores/aiStore";

const CONFIRM_MODE_OPTIONS = [
  { value: "per_call",    label: "Confirm every time (default)", desc: "Show a confirmation card for every search" },
  { value: "per_thread",  label: "Confirm once per thread",      desc: "Subsequent searches in the same thread skip the card" },
  { value: "always",      label: "Always allow",                 desc: "No confirmation card, but the drawer still shows search activity" },
  { value: "disabled",    label: "Disabled",                     desc: "Agents cannot see the search tool" },
] as const;

const PROVIDER_OPTIONS = [
  { value: "searxng",    label: "SearXNG (default, no API key required)" },
  { value: "tavily",     label: "Tavily (1k/month free, strong English)" },
  { value: "serper",     label: "Serper (Google index, strong Chinese)" },
  { value: "brave",      label: "Brave Search (independent index, ~1k/month free)" },
  { value: "exa",        label: "Exa (neural index, academic / long-tail English)" },
  { value: "google_cse", label: "Google CSE (API_KEY:CX, 100/day free)" },
] as const;

export function WebSearchPanel() {
  const { config, loadConfig, saveConfig } = useAiStore();
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);

  useEffect(() => {
    if (!config) loadConfig();
  }, []);

  if (!config) return <div className="text-[12px] text-[var(--moba-text-muted)]">Loading...</div>;

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
      setProbeResult(best ?? "All public instances are unreachable; please enter a custom URL");
    } catch (e) {
      setProbeResult(`Probe failed: ${String(e)}`);
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold">Web Search</div>
        <div className="text-[11px] text-[var(--moba-text-muted)]">
          Agent web search · Off by default · Each search requires user confirmation
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
          <div className="text-[13px] font-semibold">Enable client web search</div>
          <div className="text-[11px] text-[var(--moba-text-muted)]">
            When enabled, agents can search the web (each call requires user confirmation)
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
            <div className="text-[11px] text-[var(--moba-text-muted)] mb-1.5">Search provider</div>
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
              <div className="text-[11px] text-[var(--moba-text-muted)] mb-1">SearXNG instance URL (leave blank to auto-probe)</div>
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
                  {probing ? <Loader2 className="w-3 h-3 animate-spin" /> : "Probe fastest"}
                </button>
              </div>
              {probeResult && (
                <div className="text-[11px] text-green-400 mt-1">{probeResult}</div>
              )}
            </div>
          )}

          {/* BYOK key for Tavily/Serper/Brave/Exa/Google CSE */}
          {(ws.client_provider === "tavily" ||
            ws.client_provider === "serper" ||
            ws.client_provider === "brave" ||
            ws.client_provider === "exa" ||
            ws.client_provider === "google_cse") && (
            <div>
              <div className="text-[11px] text-[var(--moba-text-muted)] mb-1">
                {ws.client_provider === "tavily" && "Tavily API Key"}
                {ws.client_provider === "serper" && "Serper API Key"}
                {ws.client_provider === "brave" && "Brave Search API Key"}
                {ws.client_provider === "exa" && "Exa API Key"}
                {ws.client_provider === "google_cse" && "Google CSE Key (API_KEY:CX)"}
              </div>
              <input
                type="password"
                className="moba-input h-7 w-full text-[12px]"
                placeholder={
                  ws.client_provider === "google_cse"
                    ? "AIza...:abc123:xyz"
                    : "Paste API Key..."
                }
                value={ws.byok_key}
                onChange={(e) => update({ byok_key: e.target.value })}
              />
            </div>
          )}

          {/* Confirmation mode */}
          <div>
            <div className="text-[11px] text-[var(--moba-text-muted)] mb-1.5">Confirmation mode</div>
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
