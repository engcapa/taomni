import { useAiStore } from "../../../stores/aiStore";
import { DEFAULT_CONFIG } from "../../../stores/ai/defaults";
import { taoProviderOptions } from "../../../stores/ai/taoProviders";
import { taoText as tr } from "../i18n";
import type { TaoChatController, TaoChatState, TaoReasoningEffort } from "./ports";

export function TaoProviderControls({ controller, state, onClose }: {
  controller: TaoChatController; state: TaoChatState; onClose(): void;
}) {
  const config = useAiStore((value) => value.config);
  const options = taoProviderOptions(config ?? DEFAULT_CONFIG);
  const selected = options.find((option) => option.id === (state.composer.provider ?? "deepseek-app"));
  const capabilities = selected?.capabilities(state.composer.model);
  const effort = state.composer.reasoningEffort ?? "high";
  const selectModel = (model: string) => {
    const next = selected?.capabilities(model);
    controller.setModel(model, next && { ...next, reasoningEffort: next.efforts.includes(effort) ? effort : next.efforts[0] ?? "high" });
  };
  return <>
    <label>{tr("服务提供方")}<select data-testid="tao-home-provider" value={state.composer.provider ?? "deepseek-app"}
      onChange={(event) => {
        const next = options.find((option) => option.id === event.target.value);
        if (!next) return;
        const capabilities = next.capabilities(next.model);
        controller.setProvider(next.id, { model: next.model, ...capabilities, reasoningEffort: capabilities.efforts.includes(effort) ? effort : capabilities.efforts[0] ?? "high" });
      }}>
      {!selected && <option value={state.composer.provider ?? "deepseek-app"} disabled>{state.composer.provider ?? "deepseek-app"} ({tr("不可用")})</option>}
      {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select></label>
    <p className="text-[11px]">{tr("切换服务会移除附件引用；需要时请重新添加。")}</p>
    <button type="button" data-testid="tao-home-capability-thinking" disabled={!capabilities?.thinking}
      title={!capabilities?.thinking ? tr("该服务未提供可切换的思考能力") : undefined}
      onClick={() => { controller.setComposerOption("thinking", !state.composer.thinking); onClose(); }}>{tr("思考")} {state.composer.thinking ? "✓" : ""}</button>
    {capabilities?.efforts.length ? <label>{tr("思考强度")}<select data-testid="tao-home-reasoning-effort" value={capabilities.efforts.includes(effort) ? effort : capabilities.efforts[0]}
      onChange={(event) => controller.setReasoningEffort(event.target.value as TaoReasoningEffort)}>
      {capabilities.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
    </select></label> : null}
    <button type="button" data-testid="tao-home-capability-web" disabled={!capabilities?.web}
      title={!capabilities?.web ? tr("该服务未提供 Tao 联网能力") : undefined}
      onClick={() => { controller.setComposerOption("web", !state.composer.web); onClose(); }}>{tr("联网")} {state.composer.web ? "✓" : ""}</button>
    {selected?.models.map((model) => <button type="button" data-testid={`tao-home-capability-model-${model}`} key={model}
      onClick={() => { selectModel(model); onClose(); }}>{model} {state.composer.model === model ? "✓" : ""}</button>)}
    {!selected?.custom && <label>{tr("模型")}<input data-testid="tao-home-model" value={state.composer.model} disabled={!selected}
      onChange={(event) => selectModel(event.target.value)} /></label>}
  </>;
}
