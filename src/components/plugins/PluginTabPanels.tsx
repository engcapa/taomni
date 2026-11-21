import type { Tab } from "../../types";
import { useEffect } from "react";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { PluginTabPane } from "./PluginTabPane";
import { attachPluginTabPersistence } from "../../lib/pluginTabPersistence";
import { detachPluginTab } from "../../lib/pluginTabWindow";
import { useT } from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { isLegacyPluginTab, LegacyPluginTabPane } from "./LegacyPluginTabPane";
import type { MailTabInfo } from "../../types";
import type { VncSessionProperties } from "../../lib/vnc/viewerContract";

export function PluginTabPanels({ tabs, activeTabId, onOpenSettings, onClose, onStatusMessage,
  onPersistVncProperties, onRememberVncCredentials, onDetachVnc, onDetachRdp, unifiedMailAccounts,
  onOpenMailAccount, onEditMailSession }: {
  tabs: Tab[];
  activeTabId: string | null;
  onOpenSettings: () => void;
  onClose: (tabId: string) => void;
  onStatusMessage: (message: string) => void;
  onPersistVncProperties: (tabId: string, sessionId: string, properties: VncSessionProperties) => Promise<void>;
  onRememberVncCredentials: (tabId: string, sessionId: string, password: string) => Promise<void>;
  onDetachVnc: (tabId: string, info: NonNullable<Tab["vnc"]>, title: string) => void;
  onDetachRdp: (tabId: string, info: NonNullable<Tab["rdp"]>, title: string) => void;
  unifiedMailAccounts: MailTabInfo[];
  onOpenMailAccount: (sessionId: string) => void;
  onEditMailSession: (sessionId: string) => void;
}) {
  usePluginFrontendRegistry();
  const t = useT();
  useEffect(() => attachPluginTabPersistence(), []);
  return tabs.filter((tab) => tab.type === "plugin" || isLegacyPluginTab(tab)).map((tab) => (
    <div key={tab.id} className="absolute inset-0" style={{ display: tab.id === activeTabId ? "block" : "none" }}>
      {tab.type !== "plugin" ? <LegacyPluginTabPane
        tab={tab}
        active={tab.id === activeTabId}
        onOpenSettings={onOpenSettings}
        onClose={onClose}
        onStatusMessage={onStatusMessage}
        onPersistVncProperties={onPersistVncProperties}
        onRememberVncCredentials={onRememberVncCredentials}
        onDetachVnc={onDetachVnc}
        onDetachRdp={onDetachRdp}
        unifiedMailAccounts={unifiedMailAccounts}
        onOpenMailAccount={onOpenMailAccount}
        onEditMailSession={onEditMailSession}
      /> : <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 justify-end border-b border-[var(--taomni-divider)] p-1">
          <button data-testid="plugin-tab-detach" className="taomni-btn px-2 py-1 text-[12px]" onClick={() => {
            void detachPluginTab(tab).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
          }}>{t("plugins.detach")}</button>
        </div>
        <div className="min-h-0 flex-1"><PluginTabPane tab={tab} active={tab.id === activeTabId} onOpenSettings={() => {
          openSettingsSection("module-store");
          onOpenSettings();
        }} /></div>
      </div>}
    </div>
  ));
}
