import { useState } from "react";
import { useT } from "../../lib/i18n";
import { openPluginTab } from "../../lib/pluginTabs";
import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";

export function ModuleTabActions({ slug, disabled }: { slug: string; disabled: boolean }) {
  const t = useT();
  const runtime = usePluginFrontendStore();
  const record = runtime.records[slug];
  const [error, setError] = useState<string | null>(null);
  if (record?.lifecycle !== "enabled" || !record.manifest?.entry.frontend) return null;
  return <>
    {record.manifest.tabs.map((tab) => (
      <button key={tab.kind} type="button" data-testid={`module-action-open-${slug}-${tab.kind}`}
        disabled={disabled || runtime.status !== "ready" || runtime.pending.has(slug)}
        className="taomni-btn h-7 px-2.5 text-[11px]" onClick={() => {
          try { openPluginTab({ slug, kind: tab.kind }); setError(null); }
          catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
        }}>{t("plugins.open", { title: tab.title })}</button>
    ))}
    {error && <span role="alert" className="text-[12px] text-red-600">{error}</span>}
  </>;
}
