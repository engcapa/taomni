import { lazy } from "react";
import { useT } from "../../lib/i18n";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import type { VncPanelProps } from "../vnc/panel/types";
import { PluginUnavailablePane } from "./PluginUnavailablePane";

const VncPanel = lazy(() => import("../vnc/VncPanel"));
const SLUG = "vnc-client";

/** Keeps the saved tab while the registry revokes or replaces its session owner. */
export default function VncSessionPane(props: VncPanelProps) {
  const t = useT();
  const { status, records } = usePluginFrontendRegistry();
  const record = records[SLUG];

  if (status === "idle" || status === "loading") {
    return <p data-testid="plugin-tab-loading" role="status" className="p-6 text-[13px]">{t("plugins.loading")}</p>;
  }
  if (record && record.lifecycle !== "enabled") {
    const detached = props.detachedWindowControls;
    return (
      <section data-plugin-slug={SLUG} className="flex h-full min-h-0 flex-col overflow-auto">
        <PluginUnavailablePane reason={record.lifecycle === "uninstalled" ? "missing" : "disabled"}
          detail={record.reason} onOpenSettings={detached ? undefined : () => openSettingsSection("module-store")}>
          {detached && (
            <button type="button" data-testid="detached-reattach" className="taomni-btn px-3 py-1"
              onClick={detached.onReattach}>{t("rdp.reattach")}</button>
          )}
        </PluginUnavailablePane>
      </section>
    );
  }

  return <VncPanel key={record?.manifest?.version ?? "legacy"} {...props} />;
}
