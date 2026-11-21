import { lazy } from "react";
import { useT } from "../../lib/i18n";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import type { RdpPanelProps } from "../../lib/rdpViewerContract";
import { PluginTabPane } from "./PluginTabPane";

const LegacyViewer = __TAOMNI_BUNDLED_RDP_VIEWER__
  ? lazy(() => import("../../../src-tauri/plugins/rdp-client/renderer/RdpPanel"))
  : null;
const SLUG = "rdp-client";
const locator = { slug: SLUG, kind: "viewer" };

export default function RdpSessionPane(props: RdpPanelProps) {
  const t = useT();
  const { status, records, pending } = usePluginFrontendRegistry();
  if (LegacyViewer && status === "ready" && !records[SLUG] && !pending.has(SLUG)) {
    return <LegacyViewer {...props} />;
  }

  const detached = props.detachedWindowControls;
  return <PluginTabPane tab={{ id: props.tabId, plugin: locator }} active={props.visible} componentProps={props}
    onOpenSettings={detached ? undefined : () => openSettingsSection("module-store")}
    unavailableActions={detached && (
      <button type="button" data-testid="detached-reattach" className="taomni-btn px-3 py-1"
        onClick={detached.onReattach}>{t("rdp.reattach")}</button>
    )} />;
}
