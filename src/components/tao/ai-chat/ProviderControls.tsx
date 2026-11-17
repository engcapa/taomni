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
  return <>
    <label>{tr("服务提供方")}<select data-testid="tao-home-provider" value={state.composer.provider ?? "deepseek-app"}
      onChange={(event) => {
        const next = options.find((option) => option.id === event.target.value);
        if (next) controller.setProvider(next.id, { model: next.model, thinking: next.thinking, web: next.web });
      }}>
      {!selected && <option value={state.composer.provider ?? "deepseek-app"} disabled>{state.composer.provider ?? "deepseek-app"} ({tr("不可用")})</option>}
      {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select></label>
    <p className="text-[11px]">{tr("切换服务会移除附件引用；需要时请重新添加。")}</p>
    <button type="button" data-testid="tao-home-capability-thinking" disabled={!selected?.thinking}
      title={!selected?.thinking ? tr("该服务未提供可切换的思考能力") : undefined}
      onClick={() => { controller.setComposerOption("thinking", !state.composer.thinking); onClose(); }}>{tr("思考")} {state.composer.thinking ? "✓" : ""}</button>
    {selected?.reasoningEffort ? <label>{tr("思考强度")}<select data-testid="tao-home-reasoning-effort" value={state.composer.reasoningEffort ?? "high"}
      onChange={(event) => controller.setReasoningEffort(event.target.value as TaoReasoningEffort)}>
      {["low", "medium", "high", "max"].map((effort) => <option key={effort} value={effort}>{effort}</option>)}
    </select></label> : null}
    <button type="button" data-testid="tao-home-capability-web" disabled={!selected?.web}
      title={!selected?.web ? tr("该服务未提供 Tao 联网能力") : undefined}
      onClick={() => { controller.setComposerOption("web", !state.composer.web); onClose(); }}>{tr("联网")} {state.composer.web ? "✓" : ""}</button>
    {selected?.models.map((model) => <button type="button" data-testid={`tao-home-capability-model-${model}`} key={model}
      onClick={() => { controller.setModel(model); onClose(); }}>{model} {state.composer.model === model ? "✓" : ""}</button>)}
    <label>{tr("模型")}<input data-testid="tao-home-model" value={state.composer.model} disabled={!selected}
      onChange={(event) => controller.setModel(event.target.value)} /></label>
  </>;
}
