import { lazy } from "react";
import { useT } from "../../lib/i18n";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import type { VncPanelProps } from "../../lib/vnc/viewerContract";
import { PluginTabPane } from "./PluginTabPane";

const LegacyViewer = __TAOMNI_BUNDLED_VNC_VIEWER__
  ? lazy(() => import("../../../src-tauri/plugins/vnc-client/renderer/VncPanel"))
  : null;
const SLUG = "vnc-client";
const locator = { slug: SLUG, kind: "viewer" };

/** Keeps the saved tab while the registry revokes or replaces its session owner. */
export default function VncSessionPane(props: VncPanelProps) {
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
