import { useLocale } from "../../lib/i18n";
import { useAiStore } from "../../stores/aiStore";
import { DEFAULT_CONFIG } from "../../stores/ai/defaults";
import { taoProviderOptions } from "../../stores/ai/taoProviders";
import { TaoPrivacySettings } from "./TaoPrivacySettings";
import type { LlmReasoningEffort } from "../../stores/ai/model";

/** Chat defaults share the LLM panel's live draft and its single Vault-aware save. */
export function TaoSettingsPanel() {
  const { locale } = useLocale();
  const label = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const config = useAiStore((state) => state.config);
  const patch = useAiStore((state) => state.updateTaoDefaults);
  if (!config) return null;
  const options = config.deepseek_app ?? DEFAULT_CONFIG.deepseek_app!;
  const providers = taoProviderOptions(config);
  const providerId = options.provider ?? "deepseek-app";
  const selected = providers.find((provider) => provider.id === providerId);
  const capabilities = selected?.capabilities(options.model);
  const changeModel = (model: string) => {
    const next = selected?.capabilities(model);
    patch({ model, thinking_default: Boolean(next?.thinking && options.thinking_default), search_default: Boolean(next?.web && options.search_default) });
  };
  return <section data-testid="tao-settings" className="space-y-3 py-3" aria-labelledby="tao-settings-heading">
    <h3 id="tao-settings-heading" className="text-[14px] font-semibold">{label("聊天与 Agent 默认设置", "Chat and agent defaults")}</h3>
    <p className="text-[12px] text-[var(--taomni-text-muted)]">{label("与下方 LLM 服务配置一起保存。新对话使用这些默认值；已有对话保留自己的选择。", "Save together with the LLM providers below. New chats use these defaults; existing chats retain their choices.")}</p>
    <label className="flex items-center gap-2"><input type="checkbox" data-testid="tao-settings-enabled" checked={options.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />{label("启用 Tao", "Enable Tao")}</label>
    <label className="block">{label("默认服务提供方", "Default provider")}<select data-testid="tao-settings-provider" className="taomni-input w-full" value={providerId} onChange={(event) => {
      const next = providers.find((provider) => provider.id === event.target.value);
      if (!next) return;
      const capabilities = next.capabilities(next.model);
      patch({ provider: next.id, model: next.model, thinking_default: capabilities.thinking && options.thinking_default, search_default: capabilities.web && options.search_default });
    }}>
      {!selected && <option value={providerId} disabled>{providerId} ({label("不可用", "Unavailable")})</option>}
      {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
    </select></label>
    <label className="block">{label("默认模型", "Default model")}{selected?.custom
      ? <select data-testid="tao-settings-model" className="taomni-input w-full" value={options.model} onChange={(event) => changeModel(event.target.value)}>{selected.models.map((model) => <option key={model} value={model}>{model}</option>)}</select>
      : <input data-testid="tao-settings-model" className="taomni-input w-full" list="tao-default-models" value={options.model} onChange={(event) => changeModel(event.target.value)} />}</label>
    <datalist id="tao-default-models">{selected?.models.map((model) => <option key={model} value={model} />)}</datalist>
    {capabilities?.efforts.length ? <label className="block">{label("思考强度", "Reasoning effort")}<select data-testid="tao-settings-effort" className="taomni-input w-full"
      value={capabilities.efforts.includes(options.reasoning_effort ?? "high") ? options.reasoning_effort ?? "high" : capabilities.efforts[0]}
      onChange={(event) => patch({ reasoning_effort: event.target.value as LlmReasoningEffort })}>{capabilities.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label> : null}
    <div className="flex flex-wrap gap-4">
      <label><input type="checkbox" data-testid="tao-settings-thinking" checked={options.thinking_default} disabled={!capabilities?.thinking} onChange={(event) => patch({ thinking_default: event.target.checked })} /> {label("默认思考", "Thinking by default")}</label>
      <label><input type="checkbox" data-testid="tao-settings-web" checked={options.search_default} disabled={!capabilities?.web} onChange={(event) => patch({ search_default: event.target.checked })} /> {label("默认联网", "Web by default")}</label>
      <label><input type="checkbox" data-testid="tao-settings-title" checked={options.title_enabled} onChange={(event) => patch({ title_enabled: event.target.checked })} /> {label("自动标题", "Automatic titles")}</label>
    </div>
    {!capabilities?.thinking && !capabilities?.web && <p className="text-[11px]">{label("当前模型未配置思考或原生搜索。", "Thinking and native search are unavailable for the current model.")}</p>}
    <label className="block">{label("语音识别", "Speech recognition")}<select className="taomni-input w-full" data-testid="tao-settings-voice" value={options.voice_provider} onChange={(event) => patch({ voice_provider: event.target.value })}><option value="local">{label("本地（默认）", "Local (default)")}</option><option value="deepseek">DeepSeek</option></select></label>
    <label className="block">{label("朗读音色", "Read-aloud voice")}<select className="taomni-input w-full" data-testid="tao-settings-tts" value={options.tts_voice} onChange={(event) => patch({ tts_voice: event.target.value })}><option value="stella">Stella</option><option value="tide">Tide</option></select></label>
    <label className="block">
      {label("费用确认阈值（美元 $）", "Cost confirmation threshold (USD $)")}
      <input type="number" min="0" step="0.01" className="taomni-input w-full" data-testid="tao-settings-cost"
        aria-describedby="tao-settings-cost-hint" value={options.cost_confirm_threshold_usd} onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value) && value >= 0) patch({ cost_confirm_threshold_usd: value });
        }} />
    </label>
    <p id="tao-settings-cost-hint" className="text-[11px] text-[var(--taomni-text-muted)]">{label("设为 $0 可跳过费用确认。", "Set to $0 to skip cost confirmation.")}</p>
    <p className="text-[11px]">{label("安全检查：高。发送的实际资料可在提问前预览和移除。", "Safety check: high. Preview and remove excerpts before sending.")}</p>
    <TaoPrivacySettings />
  </section>;
}
