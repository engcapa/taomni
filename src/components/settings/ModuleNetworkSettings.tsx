import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { useModuleNetworkStore } from "../../stores/moduleNetworkStore";
import { AppProxyPanel } from "./AppProxyPanel";

export function ModuleNetworkSettings() {
  const t = useT();
  const { config, load, save, retry, loading, saving, error } = useModuleNetworkStore();
  useEffect(() => { void load(); }, [load]);
  return <section data-testid="module-network-settings" className="mb-5 rounded-md border border-[var(--taomni-divider)] p-3">
    <h3 className="text-[13px] font-semibold">{t("plugins.networkTitle")}</h3>
    <p className="my-2 text-[12px] text-[var(--taomni-text-muted)]">{t("plugins.networkHint")}</p>
    {config ? <>
      <label className="flex items-center gap-3 text-[12px]">
        {t("plugins.networkRoute")}
        <select data-testid="module-network-mode" className="taomni-input h-8" value={config.mode}
          onChange={(event) => { void save({ ...config, mode: event.target.value as typeof config.mode }).catch(() => undefined); }}>
          <option value="app">{t("plugins.networkApplication")}</option>
          <option value="custom">{t("plugins.networkCustom")}</option>
          <option value="none">{t("plugins.networkNone")}</option>
        </select>
      </label>
      {config.mode === "custom" && <div data-testid="module-network-custom" className="mt-3">
        <AppProxyPanel value={config.custom} onSave={(custom) => save({ ...useModuleNetworkStore.getState().config!, custom })} testHost="github.com" />
      </div>}
    </> : loading ? <p>{t("plugins.networkLoading")}</p> : null}
    <div data-testid="module-network-save-status" data-state={error ? "failed" : saving ? "saving" : loading ? "loading" : "saved"}
      className="mt-2 text-[12px] text-[var(--taomni-text-muted)]">
      {error ? <><span role="alert">{error}</span> <button type="button" data-testid="module-network-retry" className="taomni-btn"
        onClick={() => { void retry().catch(() => undefined); }}>{t("plugins.networkRetry")}</button></>
        : saving ? t("plugins.networkSaving") : loading ? t("plugins.networkLoading") : t("plugins.networkSaved")}
    </div>
  </section>;
}
