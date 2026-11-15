import { useEffect, useState } from "react";
import { useLocale } from "../../lib/i18n";
import { ensureVaultReady } from "../../lib/vaultGate";
import { useAiStore, type AiConfig, type LlmProviderConfig } from "../../stores/aiStore";
import { DEFAULT_CONFIG } from "../../stores/ai/defaults";
import { GoProxyFields } from "./GoProxyFields";
import { TaoPrivacySettings } from "./TaoPrivacySettings";

const PROVIDER: LlmProviderConfig = {
  base_url: "https://api.deepseek.com", api_key: "", model: "deepseek-flash",
  runtime: "deepseek-messages", proxy_mode: "app",
};

export function TaoSettingsPanel() {
  const { locale } = useLocale();
  const label = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const config = useAiStore((state) => state.config);
  const loadConfig = useAiStore((state) => state.loadConfig);
  const saveConfig = useAiStore((state) => state.saveConfig);
  const saving = useAiStore((state) => state.saving);
  const [draft, setDraft] = useState<AiConfig | null>(config);
  const [message, setMessage] = useState("");
  useEffect(() => { if (!config) void loadConfig(); }, [config, loadConfig]);
  useEffect(() => { setDraft(config); }, [config]);
  if (!draft) return null;
  const options = draft.deepseek_app ?? DEFAULT_CONFIG.deepseek_app!;
  const provider = draft.llm.providers["deepseek-app"] ?? PROVIDER;
  const setProvider = (next: LlmProviderConfig) => setDraft({ ...draft, llm: { ...draft.llm, providers: { ...draft.llm.providers, "deepseek-app": next } } });
  const patch = (value: Partial<typeof options>) => setDraft({ ...draft, deepseek_app: { ...options, ...value } });
  const save = async () => {
    setMessage("");
    try {
      const keys = provider.api_keys?.length ? provider.api_keys : [provider.api_key];
      if (keys.some((key) => key && !key.startsWith("vault:"))) {
        if (!await ensureVaultReady(label("保存 Tao Key", "Save Tao key"))) return;
      }
      await saveConfig({ ...draft, deepseek_app: options, llm: { ...draft.llm, providers: { ...draft.llm.providers, "deepseek-app": provider } } });
      setMessage(label("已保存", "Saved"));
    } catch (error) { setMessage(String(error)); }
  };
  return <div data-testid="tao-settings" className="space-y-3 py-3">
    <h3 className="text-[14px] font-semibold">Tao · DeepSeek</h3>
    <p className="text-[12px] text-[var(--taomni-text-muted)]">{label("新对话使用以下默认设置；已有对话保留自己的模型和能力选择。", "New chats use these defaults. Existing chats retain their own model and capabilities.")}</p>
    <label className="flex items-center gap-2"><input type="checkbox" data-testid="tao-settings-enabled" checked={options.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />{label("启用 Tao", "Enable Tao")}</label>
    <label className="block">{label("接口地址", "Endpoint")}<input className="taomni-input w-full" data-testid="tao-settings-endpoint" value={provider.base_url} onChange={(event) => setProvider({ ...provider, base_url: event.target.value })} /></label>
    <label className="block">API Key<input type="password" className="taomni-input w-full" autoComplete="off" data-testid="tao-settings-key" value={provider.api_key} onChange={(event) => setProvider({ ...provider, api_key: event.target.value, api_keys: [event.target.value] })} /></label>
    <p className="text-[11px]">{label("Key 保存到 Vault，不会自动测试或发起付费请求。", "Keys are saved in Vault. Saving does not send a test or a paid request.")}</p>
    <GoProxyFields provider={provider} onChange={setProvider} />
    <label className="block">{label("默认模型", "Default model")}<select data-testid="tao-settings-model" className="taomni-input w-full" value={options.model} onChange={(event) => patch({ model: event.target.value })}><option value="deepseek-flash">deepseek-flash</option><option value="deepseek-v4-pro">deepseek-v4-pro</option></select></label>
    <div className="flex flex-wrap gap-4">
      <label><input type="checkbox" data-testid="tao-settings-thinking" checked={options.thinking_default} onChange={(event) => patch({ thinking_default: event.target.checked })} /> {label("默认思考", "Thinking by default")}</label>
      <label><input type="checkbox" data-testid="tao-settings-web" checked={options.search_default} onChange={(event) => patch({ search_default: event.target.checked })} /> {label("默认联网", "Web by default")}</label>
      <label><input type="checkbox" data-testid="tao-settings-title" checked={options.title_enabled} onChange={(event) => patch({ title_enabled: event.target.checked })} /> {label("自动标题", "Automatic titles")}</label>
    </div>
    <label className="block">{label("语音识别", "Speech recognition")}<select className="taomni-input w-full" data-testid="tao-settings-voice" value={options.voice_provider} onChange={(event) => patch({ voice_provider: event.target.value })}><option value="local">{label("本地（默认）", "Local (default)")}</option><option value="deepseek">DeepSeek</option></select></label>
    <label className="block">{label("朗读音色", "Read-aloud voice")}<select className="taomni-input w-full" data-testid="tao-settings-tts" value={options.tts_voice} onChange={(event) => patch({ tts_voice: event.target.value })}><option value="stella">Stella</option><option value="tide">Tide</option></select></label>
    <label className="block">{label("费用再次确认阈值（人民币）", "Cost confirmation threshold (CNY)")}<input type="number" min="0" step="0.1" className="taomni-input w-full" data-testid="tao-settings-cost" value={options.cost_confirm_threshold_cny} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0) patch({ cost_confirm_threshold_cny: value }); }} /></label>
    <p className="text-[11px]">{label("安全检查：高。发送的实际资料可在提问前预览和移除。", "Safety check: high. Preview and remove excerpts before sending.")}</p>
    <button className="taomni-btn px-3 py-1" data-testid="tao-settings-save" disabled={saving} onClick={() => void save()}>{saving ? label("保存中…", "Saving…") : label("保存 Tao 设置", "Save Tao settings")}</button>
    {message && <p role="status" data-testid="tao-settings-status">{message}</p>}
    <TaoPrivacySettings />
  </div>;
}
