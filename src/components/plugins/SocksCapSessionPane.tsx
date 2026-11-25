import { lazy } from "react";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import { PluginTabPane } from "./PluginTabPane";

const LegacySocksCap = __TAOMNI_BUNDLED_SOCKSCAP_RENDERER__
  ? lazy(() => import("../../../src-tauri/plugins/sockscap/renderer/SocksCapViewEntry"))
  : null;
const locator = { slug: "sockscap", kind: "settings" };

type Controls = { onClose: () => void; onStatusMessage: (message: string) => void };

export default function SocksCapSessionPane({ tabId, active, ...controls }: Controls & { tabId: string; active: boolean }) {
  const { status, records, pending } = usePluginFrontendRegistry();
  const record = records[locator.slug];
  if (LegacySocksCap && status === "ready" && !pending.has(locator.slug)
    && (!record || (record.lifecycle === "enabled" && !record.manifest?.entry.frontend))) {
    return <LegacySocksCap {...controls} />;
  }
  return <PluginTabPane tab={{ id: tabId, plugin: locator }} active={active} componentProps={controls}
    onOpenSettings={() => openSettingsSection("module-store")} />;
}
