import { useEffect, useMemo, useState } from "react";
import { useOpencodeGoStore, type GoModelEntry, type GoProtocol } from "../../stores/opencodeGoStore";
import { useT } from "../../lib/i18n";

export const GO_PROTOCOLS: GoProtocol[] = ["chat", "messages", "responses", "google"];

export function effectiveGoModels(models: GoModelEntry[], overrides: Record<string, string> = {}): GoModelEntry[] {
  return models.map((model) => overrides[model.id] ? {
    ...model,
    protocol: GO_PROTOCOLS.includes(overrides[model.id] as GoProtocol) ? overrides[model.id] as GoProtocol : "chat",
    protocol_source: "user_override",
  } : model);
}

export function GoModelLabel({ model }: { model: GoModelEntry }) {
  const t = useT();
  return <>{model.name} · {model.protocol}
    {model.context_limit ? ` · ${model.context_limit.toLocaleString()}` : ""}
    {model.protocol_source === "default" ? ` · ${t("opencodeGo.unclassified")}` : ""}
    {model.status === "deprecated" ? ` · ${t("opencodeGo.deprecated")}` : ""}
    {model.training_use ? ` · ${t("opencodeGo.training")}` : ""}
  </>;
}

export function GoCatalogStatus({ blocked = false }: { blocked?: boolean }) {
  const t = useT();
  const catalog = useOpencodeGoStore();
  return <div className="text-[11px] text-[var(--taomni-text-muted)]" data-testid="go-catalog-status">
    <span>{t("opencodeGo.catalog", { count: catalog.models.length })} · {t(`opencodeGo.${catalog.source}`)} · {catalog.fetched_at
      ? new Date(catalog.fetched_at * 1000).toLocaleString() : t("opencodeGo.notRefreshed")}</span>
    <button type="button" data-testid="go-catalog-refresh" className="taomni-btn ml-2 px-2"
      disabled={blocked || catalog.loading} onClick={() => void catalog.refresh(true)}>
      {t(catalog.loading ? "opencodeGo.refreshing" : "opencodeGo.refresh")}
    </button>
    {blocked && <p data-testid="go-catalog-blocked">{t("opencodeGo.blocked")}</p>}
    {catalog.last_error && <p role="alert" data-testid="go-catalog-error">{catalog.last_error}</p>}
  </div>;
}

/** Same compact header location as bridge selectors; persistence stays with caller. */
export function GoModelPicker({ value, defaultModel, onChange, blocked = false, inherit = false, testId = "go-default-model", overrides }: {
  value: string | null | undefined;
  defaultModel: string;
  onChange: (model: string | null) => void | Promise<void>;
  blocked?: boolean;
  inherit?: boolean;
  testId?: string;
  overrides?: Record<string, string>;
}) {
  const t = useT();
  const models = useOpencodeGoStore((s) => s.models);
  const ensureLoaded = useOpencodeGoStore((s) => s.ensureLoaded);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { void ensureLoaded(blocked); }, [ensureLoaded, blocked]);
  const filtered = useMemo(() => effectiveGoModels(models, overrides).filter((m) => `${m.name} ${m.id} ${m.protocol}`.toLowerCase().includes(search.toLowerCase())), [models, search, overrides]);
  const selected = value || (inherit ? "" : defaultModel);
  const missing = selected && !models.some((m) => m.id === selected);
  const change = async (model: string | null) => {
    setSaving(true); setError(null);
    try { await onChange(model); } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  };
  return <div data-testid={testId} className="min-w-0 max-w-full space-y-1">
    <input data-testid={`${testId}-search`} className="taomni-input h-6 w-full text-[11px]"
      aria-label={t("opencodeGo.search")} placeholder={t("opencodeGo.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
    {models.length > 0 ? <select data-testid={`${testId}-select`} className="taomni-input h-7 w-full text-[11px]"
      aria-label={t("opencodeGo.model")} value={selected} disabled={saving}
      onChange={(e) => void change(e.target.value || null)}>
      {inherit && <option value="">{t("opencodeGo.inherit", { model: defaultModel })}</option>}
      {missing && <option value={selected}>{selected} · {t("opencodeGo.offlineModel")}</option>}
      {selected && !missing && !filtered.some((m) => m.id === selected) && <option value={selected}>{selected}</option>}
      {GO_PROTOCOLS.map((protocol) => <optgroup key={protocol} label={protocol}>
        {filtered.filter((m) => m.protocol === protocol).map((model) => <option key={model.id} value={model.id}><GoModelLabel model={model} /></option>)}
      </optgroup>)}
    </select> : <input data-testid={`${testId}-fallback`} className="taomni-input h-7 w-full text-[11px]"
      aria-label={t("opencodeGo.model")} value={selected} onChange={(e) => void change(e.target.value || null)} />}
    {error && <p role="alert">{error}</p>}
  </div>;
}
