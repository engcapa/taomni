import { lazy, Suspense, type ReactNode } from "react";
import type { VncSessionProperties } from "../../lib/vnc/viewerContract";
import type { MailTabInfo, Tab } from "../../types";
import { useT } from "../../lib/i18n";
import MailSessionPane from "./MailSessionPane";
import RdpSessionPane from "./RdpSessionPane";
import SocksCapSessionPane from "./SocksCapSessionPane";
import VncSessionPane from "./VncSessionPane";

const LegacyMfaTab = lazy(() => import("../mfa/MfaTab").then((module) => ({ default: module.MfaTab })));
const LegacyServersPanel = lazy(() => import("../servers/ServersPanel").then((module) => ({ default: module.ServersPanel })));
const LegacyProxyTestTab = lazy(() => import("../proxy/ProxyTestTab"));

export interface LegacyPluginTabPaneProps {
  tab: Tab;
  active: boolean;
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
}

function LoadingPanel() {
  const t = useT();
  return <div className="flex h-full items-center justify-center text-sm text-[var(--taomni-text-muted)]" role="status">{t("plugins.loading")}</div>;
}

function MissingPayload({ tab }: { tab: Tab }) {
  const t = useT();
  return <div className="flex h-full items-center justify-center p-6 text-center text-sm" role="alert">
    <div><p className="font-semibold">{tab.title}</p><p className="mt-2 text-[var(--taomni-text-muted)]">{t("plugins.unavailable")}</p></div>
  </div>;
}

/**
 * Transitional adapter for persisted legacy tab kinds. The main shell only
 * knows the adapter boundary. Each import can later be replaced by the
 * signed module frontend without changing tab restoration or callbacks.
 */
export function LegacyPluginTabPane(props: LegacyPluginTabPaneProps) {
  const { tab, active } = props;
  let content: ReactNode;
  switch (tab.type) {
    case "mfa":
      content = <LegacyMfaTab onStatusMessage={props.onStatusMessage} />;
      break;
    case "servers":
      content = <LegacyServersPanel onClose={() => props.onClose(tab.id)} />;
      break;
    case "sockscap":
      content = <SocksCapSessionPane tabId={tab.id} active={active} onStatusMessage={props.onStatusMessage}
        onClose={() => props.onClose(tab.id)} />;
      break;
    case "proxy-test":
      content = tab.proxyTest ? <LegacyProxyTestTab info={tab.proxyTest} /> : <MissingPayload tab={tab} />;
      break;
    case "mail":
      content = tab.mail ? <MailSessionPane view="account" tabId={tab.id} info={tab.mail} active={active} onEditSession={props.onEditMailSession} /> : <MissingPayload tab={tab} />;
      break;
    case "mail-unified":
      content = <MailSessionPane view="unified" tabId={tab.id} accounts={props.unifiedMailAccounts} active={active} onOpenAccount={props.onOpenMailAccount} />;
      break;
    case "rdp": {
      const info = tab.rdp;
      content = info ? <RdpSessionPane
        tabId={tab.id}
        host={info.host}
        port={info.port}
        username={info.username}
        password={info.password}
        options={info.options}
        networkSettingsJson={info.networkSettingsJson}
        visible={active}
        onDetach={() => props.onDetachRdp(tab.id, info, tab.title)}
      /> : <MissingPayload tab={tab} />;
      break;
    }
    case "vnc": {
      const info = tab.vnc;
      content = info ? <VncSessionPane
        tabId={tab.id}
        host={info.host}
        port={info.port}
        username={info.username}
        password={info.password}
        networkSettingsJson={info.networkSettingsJson}
        securityPolicy={info.securityPolicy}
        viewOnly={info.viewOnly}
        clipboardPolicy={info.clipboardPolicy}
        viewerOptions={info.viewerOptions}
        visible={active}
        onSessionPropertiesChange={(properties) => props.onPersistVncProperties(tab.id, info.sessionId, properties)}
        onCredentialsChange={({ password }) => props.onRememberVncCredentials(tab.id, info.sessionId, password)}
        onDetach={() => props.onDetachVnc(tab.id, info, tab.title)}
      /> : <MissingPayload tab={tab} />;
      break;
    }
    default:
      content = <MissingPayload tab={tab} />;
  }
  return <Suspense fallback={<LoadingPanel />}><div className="h-full min-h-0">{content}</div></Suspense>;
}

export function isLegacyPluginTab(tab: Tab): boolean {
  return tab.type === "mfa" || tab.type === "servers" || tab.type === "sockscap"
    || tab.type === "proxy-test" || tab.type === "rdp" || tab.type === "vnc"
    || tab.type === "mail" || tab.type === "mail-unified";
}
