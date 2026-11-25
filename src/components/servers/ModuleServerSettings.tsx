import { lazy, Suspense } from "react";
import { useT } from "../../lib/i18n";
import { serverSettingsModule, type ServerSettingsInput } from "../../lib/servers/rendererContract";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import { PluginTabPane } from "../plugins/PluginTabPane";

const bundledSettings = __TAOMNI_BUNDLED_SERVER_SETTINGS__ ? {
  "rdp-server": lazy(() => import("../../../src-tauri/plugins/rdp-server/renderer/RdpSettings")),
  "vnc-server": lazy(() => import("../../../src-tauri/plugins/vnc-server/renderer/VncSettings")),
  servers: lazy(() => import("../../../src-tauri/plugins/servers/renderer/LocalServerSettings")),
} : null;

export function ModuleServerSettings(input: ServerSettingsInput) {
  const t = useT();
  const { records, pending, status } = usePluginFrontendRegistry();
  const slug = serverSettingsModule(input.serverType);
  const record = records[slug];
  const BundledSettings = bundledSettings?.[slug];
  if (BundledSettings && status === "ready" && !pending.has(slug)
    && (!record || (record.lifecycle === "enabled" && !record.reason && !record.manifest?.entry.frontend))) {
    return <Suspense fallback={<p role="status">{t("plugins.loading")}</p>}>
      <BundledSettings {...input} />
    </Suspense>;
  }

  return <PluginTabPane<ServerSettingsInput>
    tab={{ id: "server-settings", plugin: { slug, kind: input.serverType } }}
    active
    componentProps={input}
    className="flex min-w-0 flex-col"
    onOpenSettings={() => openSettingsSection("module-store")}
  />;
}
