import { Plus, Trash2 } from "lucide-react";
import { useLocale } from "../../lib/i18n";
import { CUSTOM_LLM_PROTOCOLS, customReasoningEfforts, newCustomModel } from "../../stores/ai/customLlm";
import type { CustomLlmModelConfig, LlmProviderConfig } from "../../stores/ai/model";

export function CustomLlmProviderFields({ provider, onChange, focusName }: {
  provider: LlmProviderConfig;
  onChange: (provider: LlmProviderConfig) => void;
  focusName: boolean;
}) {
  const { locale } = useLocale();
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const custom = provider.custom!;
  const efforts = customReasoningEfforts(provider.runtime);
  const setModels = (models: CustomLlmModelConfig[], model: string) => onChange({ ...provider, model, custom: { ...custom, models } });
  const updateModel = (index: number, patch: Partial<CustomLlmModelConfig>) => {
    const models = custom.models.map((model, current) => current === index ? { ...model, ...patch } : model);
    setModels(models, custom.models[index].id === provider.model ? models[index].id : provider.model);
  };
  const fieldClass = "taomni-input h-7 w-full";
  return <div className="space-y-2" data-testid="llm-custom-fields">
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-2">
      <label>{text("服务名称", "Provider name")}<input autoFocus={focusName} className={fieldClass}
        data-testid="llm-custom-name" value={custom.label} onChange={(event) => onChange({ ...provider, custom: { ...custom, label: event.target.value } })} /></label>
      <label>{text("协议", "Protocol")}<select className={fieldClass} data-testid="llm-custom-protocol" value={provider.runtime} onChange={(event) => {
        const runtime = event.target.value;
        onChange({ ...provider, runtime, custom: { ...custom, models: custom.models.map((model) => ({
          ...model, reasoning_efforts: model.reasoning_efforts.filter((effort) => customReasoningEfforts(runtime).includes(effort)),
        })) } });
      }}>{Object.entries(CUSTOM_LLM_PROTOCOLS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-semibold">{text("手工配置模型", "Configured models")}</span>
      <button type="button" className="taomni-btn inline-flex items-center gap-1 px-2" data-testid="llm-custom-add-model"
        onClick={() => setModels([...custom.models, newCustomModel()], provider.model)}><Plus size={14} />{text("添加模型", "Add model")}</button>
    </div>
    {custom.models.map((model, index) => <fieldset key={index} className="min-w-0 space-y-2 rounded border border-[var(--taomni-divider)] p-2" data-testid="llm-custom-model-row">
      <legend className="px-1 text-[var(--taomni-text-muted)]">{model.id || text("新模型", "New model")}</legend>
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">{text("模型 ID", "Model ID")}<input className={fieldClass} data-testid="llm-custom-model-id"
          value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })} /></label>
        <button type="button" className="taomni-btn h-7 w-7 inline-flex items-center justify-center"
          aria-label={text("移除模型", "Remove model")} data-testid="llm-custom-remove-model" disabled={custom.models.length === 1} onClick={() => {
            const models = custom.models.filter((_, current) => current !== index);
            setModels(models, model.id === provider.model ? models[0].id : provider.model);
          }}><Trash2 size={14} /></button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))] gap-2">
        <label>{text("上下文大小（Token）", "Context size (tokens)")}<input type="number" min="1" step="1" className={fieldClass}
          data-testid="llm-custom-context" value={model.context_window || ""} onChange={(event) => updateModel(index, { context_window: Number(event.target.value) })} /></label>
        <label>{text("最大输出 Token", "Max output tokens")}<input type="number" min="1" step="1" className={fieldClass}
          data-testid="llm-custom-max-output" value={model.max_output_tokens || ""} onChange={(event) => updateModel(index, { max_output_tokens: Number(event.target.value) })} /></label>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex items-center gap-1"><input type="checkbox" data-testid="llm-custom-multimodal" checked={model.multimodal}
          onChange={(event) => updateModel(index, { multimodal: event.target.checked })} />{text("多模态图像输入", "Multimodal image input")}</label>
        <label className="flex items-center gap-1"><input type="checkbox" data-testid="llm-custom-native-search" checked={model.native_search}
          onChange={(event) => updateModel(index, { native_search: event.target.checked })} />{text("原生搜索", "Native search")}</label>
      </div>
      <fieldset className="flex flex-wrap gap-2">
        <legend>{text("支持的推理强度", "Supported reasoning effort")}</legend>
        {efforts.map((effort) => <label key={effort} className="flex items-center gap-1"><input type="checkbox"
          data-testid={`llm-custom-effort-${effort}`} checked={model.reasoning_efforts.includes(effort)} onChange={(event) => updateModel(index, {
            reasoning_efforts: efforts.filter((value) => value === effort ? event.target.checked : model.reasoning_efforts.includes(value)),
          })} />{effort}</label>)}
      </fieldset>
    </fieldset>)}
    <label>{text("默认模型", "Default model")}<select className={fieldClass} data-testid="llm-custom-default-model" value={provider.model}
      onChange={(event) => setModels(custom.models, event.target.value)}>{custom.models.map((model, index) => <option key={index} value={model.id}>{model.id || text("新模型", "New model")}</option>)}</select></label>
  </div>;
}
