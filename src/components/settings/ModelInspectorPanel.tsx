import { useEffect, useRef, useState } from "react";
import { useAiStore } from "../../stores/aiStore";
import { useT } from "../../lib/i18n";
import { useModelInspectorStore, type InspectorRow } from "../../stores/modelInspectorStore";

interface Props { providerId: string; currentModel: string; blocked: boolean; onClose: () => void }
const unknown = "—";
export function ModelInspectorPanel({ providerId, currentModel, blocked, onClose }: Props) {
  const t = useT();
  const provider = useAiStore((s) => s.config?.llm.providers[providerId]);
  const { entries, load, check, checkAll, selectModel } = useModelInspectorStore();
  const entry = entries[providerId];
  const data = entry?.data;
  const [confirmAll, setConfirmAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.focus(); }, [providerId]);
  useEffect(() => {
    const timer = setTimeout(() => void load(providerId), 150);
    return () => clearTimeout(timer);
  }, [providerId, load, blocked, provider]);
  // The DTO is a historical snapshot; current policy controls recovery.
  const disabled = blocked;
  const busy = !!entry?.batch || !!entry?.pending.length;
  const rows = [...(data?.rows ?? [])].sort((a, b) =>
    Number(b.id === currentModel) - Number(a.id === currentModel) || a.id.localeCompare(b.id));
  const select = async (model: string) => {
    setSaving(true); setSaveError(null);
    try { await selectModel(providerId, model); }
    catch (error) { setSaveError(String(error)); }
    finally { setSaving(false); }
  };
  const bool = (value: boolean | null) => value == null ? unknown : t(`modelInspector.${value ? "yes" : "no"}`);
  const cost = (row: InspectorRow) => ["input", "output", "cache_read"]
    .map((key) => row.cost?.[key] == null ? unknown : String(row.cost[key])).join(" / ");
  return <div ref={panel} tabIndex={-1} role="region" aria-label={t("modelInspector.title")}
    data-testid="model-inspector-panel" data-provider={providerId}
    className="border border-[var(--taomni-divider)] rounded p-2 space-y-2 text-[12px]"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div className="flex flex-wrap items-center gap-2">
      <strong>{t("modelInspector.title")}</strong>
      <span data-testid="model-inspector-summary">{t("modelInspector.count", { count: rows.length })} ·
        {data?.fetched_at ? new Date(data.fetched_at * 1000).toLocaleString() : unknown} ·
        {data ? t(`modelInspector.${data.source}`) : unknown}</span>
      <button type="button" data-testid="model-inspector-refresh" className="taomni-btn px-2"
        disabled={!!entry?.loading || busy || disabled} onClick={() => void load(providerId, true)}>{t("modelInspector.refresh")}</button>
      <button type="button" data-testid="model-inspector-check-current" className="taomni-btn px-2"
        disabled={disabled || busy || !rows.some((r) => r.id === currentModel)}
        onClick={() => void check(providerId, currentModel)}>{t("modelInspector.checkCurrent")}</button>
      <button type="button" data-testid="model-inspector-check-all" className="taomni-btn px-2"
        disabled={disabled || busy || !rows.length} onClick={() => setConfirmAll(true)}>{t("modelInspector.checkAll")}</button>
      <button type="button" data-testid="model-inspector-close" className="taomni-btn px-2 ml-auto"
        onClick={onClose}>{t("modelInspector.close")}</button>
    </div>
    {confirmAll && <div data-testid="model-inspector-confirm" role="alert" className="space-x-2">
      <span>{t("modelInspector.confirmAll")}</span>
      <button type="button" data-testid="model-inspector-confirm-all" className="taomni-btn px-2" disabled={disabled || busy}
        onClick={() => { setConfirmAll(false); void checkAll(providerId); }}>{t("modelInspector.confirm")}</button>
      <button type="button" data-testid="model-inspector-cancel-all" className="taomni-btn px-2"
        onClick={() => setConfirmAll(false)}>{t("modelInspector.cancel")}</button>
    </div>}
    {entry?.loading && <p data-testid="model-inspector-loading" role="status">{t("modelInspector.loading")}</p>}
    {disabled && <p data-testid="model-inspector-disabled">{t("modelInspector.disabled")}</p>}
    {(entry?.error || data?.last_error || saveError) && <p data-testid="model-inspector-error" role="alert">
      {saveError ?? entry?.error ?? data?.last_error}</p>}
    {data?.unavailable && <p data-testid="model-inspector-unavailable">{t("modelInspector.unavailable")}</p>}
    {data && !rows.length && !data.unavailable && <p data-testid="model-inspector-empty">{t("modelInspector.empty")}</p>}
    <div className="overflow-auto max-h-96" data-testid="model-inspector-scroll">
      <table className="w-full text-left whitespace-nowrap">
        <thead><tr>{["model", "protocol", "context", "output", "modalities", "tools", "reasoning", "cost", "status", "source", "lastCheck", "actions"]
          .map((column) => <th className="px-2 py-1" key={column}>{t(`modelInspector.${column}`)}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id} data-testid="model-inspector-row" data-model={row.id}
          data-source={row.metadata_source} data-current={row.id === currentModel} data-live={row.live_exists ?? "unknown"}
          className={row.id === currentModel ? "bg-[var(--taomni-accent)]/10" : row.live_exists === false ? "text-[var(--taomni-text-muted)]" : ""}>
          <td className="px-2 py-1"><strong>{row.name}</strong><div>{row.id}</div></td>
          <td className="px-2" title={row.protocol_source ?? ""}>{row.protocol}</td>
          <td className="px-2">{row.context_limit ?? unknown}</td><td className="px-2">{row.output_limit ?? unknown}</td>
          <td className="px-2">{row.input_modalities?.join(", ") || unknown} → {row.output_modalities?.join(", ") || unknown}</td>
          <td className="px-2">{bool(row.tool_call)}</td><td className="px-2">{bool(row.reasoning)}</td>
          <td className="px-2">{cost(row)}</td>
          <td className="px-2">{row.status ?? unknown}{row.live_exists === false && <div>{t("modelInspector.notLive")}</div>}</td>
          <td className="px-2">{t(`modelInspector.${row.metadata_source}`)}</td>
          <td className="px-2" data-testid="model-inspector-result" title={row.check?.error ?? ""}>
            {entry?.pending.includes(row.id) ? t("modelInspector.checking") : row.check ? <>
              {row.check.ok ? `✓ ${row.check.latency_ms ?? unknown}ms` : `✗ ${row.check.error?.split("\n")[0].slice(0, 100) ?? unknown}`}
              <div>{new Date(row.check.checked_at * 1000).toLocaleString()}</div>
            </> : unknown}
          </td>
          <td className="px-2 space-x-1">
            <button type="button" data-testid="model-inspector-check" className="taomni-btn px-2"
              disabled={disabled || busy} onClick={() => void check(providerId, row.id)}>{t("modelInspector.check")}</button>
            <button type="button" data-testid="model-inspector-select" className="taomni-btn px-2"
              disabled={disabled || saving || row.id === currentModel} onClick={() => void select(row.id)}>{t("modelInspector.select")}</button>
          </td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}
