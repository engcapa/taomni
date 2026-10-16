import { GO_PROTOCOLS, GoCatalogStatus, GoModelLabel, GoModelPicker, effectiveGoModels } from "../chat/GoModelPicker";
import { useOpencodeGoStore } from "../../stores/opencodeGoStore";
import { useT } from "../../lib/i18n";
import type { LlmProviderConfig } from "../../stores/aiStore";

export function GoProviderFields({ provider, onChange, blocked }: {
  provider: LlmProviderConfig;
  onChange: (provider: LlmProviderConfig) => void;
  blocked: boolean;
}) {
  const t = useT();
  const models = useOpencodeGoStore((s) => s.models);
  return <div className="space-y-2">
    <GoModelPicker value={provider.model} defaultModel={provider.model} blocked={blocked}
      overrides={provider.protocol_overrides}
      onChange={(model) => onChange({ ...provider, model: model || "deepseek-v4.1-flash" })} />
    <GoCatalogStatus blocked={blocked} />
    <details data-testid="go-protocols">
      <summary className="cursor-pointer text-[12px]">{t("opencodeGo.protocols")}</summary>
      <div className="max-h-64 overflow-auto space-y-1">
        {models.map((model) => {
          const override = provider.protocol_overrides?.[model.id];
          return <div key={model.id} data-testid="go-protocol-row" data-model={model.id} className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="flex-1 min-w-0"><GoModelLabel model={effectiveGoModels([model], provider.protocol_overrides)[0]} /></span>
            <select data-testid="go-protocol-select" aria-label={`${model.name} ${t("opencodeGo.protocols")}`}
              value={override ? (GO_PROTOCOLS.includes(override as typeof GO_PROTOCOLS[number]) ? override : "chat") : model.protocol}
              onChange={(e) => onChange({ ...provider, protocol_overrides: { ...provider.protocol_overrides, [model.id]: e.target.value } })}>
              {GO_PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <small>{t(`opencodeGo.${override ? "user_override" : model.protocol_source}`)}</small>
            <button type="button" data-testid="go-protocol-reset" disabled={!override} className="taomni-btn px-1"
              onClick={() => {
                const next = { ...provider.protocol_overrides }; delete next[model.id];
                onChange({ ...provider, protocol_overrides: next });
              }}>{t("opencodeGo.automatic")}</button>
          </div>;
        })}
      </div>
    </details>
  </div>;
}
