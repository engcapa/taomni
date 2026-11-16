import type { Tab } from "../../types";
import { useEffect } from "react";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { PluginTabPane } from "./PluginTabPane";
import { attachPluginTabPersistence } from "../../lib/pluginTabPersistence";
import { detachPluginTab } from "../../lib/pluginTabWindow";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";

export function PluginTabPanels({ tabs, activeTabId, onOpenSettings }: {
  tabs: Tab[];
  activeTabId: string | null;
  onOpenSettings: () => void;
}) {
  usePluginFrontendRegistry();
  const t = useT();
  useEffect(() => attachPluginTabPersistence(), []);
  return tabs.filter((tab) => tab.type === "plugin").map((tab) => (
    <div key={tab.id} className="absolute inset-0" style={{ display: tab.id === activeTabId ? "block" : "none" }}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 justify-end border-b border-[var(--taomni-divider)] p-1">
          <button data-testid="plugin-tab-detach" className="taomni-btn px-2 py-1 text-[12px]" onClick={() => {
            void detachPluginTab(tab).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
          }}>{t("plugins.detach")}</button>
        </div>
        <div className="min-h-0 flex-1"><PluginTabPane tab={tab} active={tab.id === activeTabId} onOpenSettings={() => {
          openSettingsSection("module-store");
          onOpenSettings();
        }} /></div>
      </div>
    </div>
  ));
}
