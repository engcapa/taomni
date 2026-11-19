import { useAiStore } from "../../../stores/aiStore";
import { ThemedSelect } from "../../ThemedSelect";
import { DEFAULT_CONFIG } from "../../../stores/ai/defaults";
import { taoProviderOptions } from "../../../stores/ai/taoProviders";
import { taoText as tr } from "../i18n";
import type { TaoChatController, TaoChatState, TaoReasoningEffort } from "./ports";

export function TaoProviderControls({ controller, state, onClose }: {
  controller: TaoChatController; state: TaoChatState; onClose(): void;
}) {
  const config = useAiStore((value) => value.config);
  const provider = state.composer.provider ?? "deepseek-app";
  const options = taoProviderOptions(config ?? DEFAULT_CONFIG);
  const selected = options.find((option) => option.id === provider);
  const capabilities = selected?.capabilities(state.composer.model);
  const effort = state.composer.reasoningEffort ?? "high";
  const selectModel = (model: string) => {
    const next = selected?.capabilities(model);
    controller.setModel(model, next && { ...next, reasoningEffort: next.efforts.includes(effort) ? effort : next.efforts[0] ?? "high" });
  };
  return <>
    <div className="tao-home-control-field"><span>{tr("服务提供方")}</span><ThemedSelect testId="tao-home-provider" label={tr("服务提供方")} value={provider}
      options={[
        ...(selected ? [] : [{ value: provider, label: `${provider} (${tr("不可用")})`, disabled: true }]),
        ...options.map((option) => ({ value: option.id, label: option.label })),
      ]}
      onChange={(value) => {
        const next = options.find((option) => option.id === value);
        if (!next) return;
        const capabilities = next.capabilities(next.model);
        controller.setProvider(next.id, { model: next.model, ...capabilities, reasoningEffort: capabilities.efforts.includes(effort) ? effort : capabilities.efforts[0] ?? "high" });
      }} /></div>
    <p className="text-[11px]">{tr("切换服务会移除附件引用；需要时请重新添加。")}</p>
    <button type="button" data-testid="tao-home-capability-thinking" disabled={!capabilities?.thinking}
      title={!capabilities?.thinking ? tr("该服务未提供可切换的思考能力") : undefined}
      onClick={() => { controller.setComposerOption("thinking", !state.composer.thinking); onClose(); }}>{tr("思考")} {state.composer.thinking ? "✓" : ""}</button>
    {capabilities?.efforts.length ? <div className="tao-home-control-field"><span>{tr("思考强度")}</span>
      <ThemedSelect<TaoReasoningEffort> testId="tao-home-reasoning-effort" label={tr("思考强度")}
        value={capabilities.efforts.includes(effort) ? effort : capabilities.efforts[0]}
        options={capabilities.efforts.map((value) => ({ value, label: value }))}
        onChange={(value) => controller.setReasoningEffort(value)} />
    </div> : null}
    <button type="button" data-testid="tao-home-capability-web" disabled={!capabilities?.web}
      title={!capabilities?.web ? tr("该服务未提供 Tao 联网能力") : undefined}
      onClick={() => { controller.setComposerOption("web", !state.composer.web); onClose(); }}>{tr("联网")} {state.composer.web ? "✓" : ""}</button>
    {selected?.models.map((model) => <button type="button" data-testid={`tao-home-capability-model-${model}`} key={model}
      onClick={() => { selectModel(model); onClose(); }}>{model} {state.composer.model === model ? "✓" : ""}</button>)}
    {!selected?.custom && <label>{tr("模型")}<input data-testid="tao-home-model" value={state.composer.model} disabled={!selected}
      onChange={(event) => selectModel(event.target.value)} /></label>}
  </>;
}
