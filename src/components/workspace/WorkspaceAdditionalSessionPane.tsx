import { Suspense } from "react";
import { MailClientTab } from "../mail/MailClientTab";
import { ObjectStorageBrowser } from "../objectstorage/ObjectStorageBrowser";
import { ProxyTestTab } from "../../layouts/main/panels";
import { mailSmtpPasswordRefFromOptions, sessionToMailTabInfo } from "../../layouts/main/mailSession";
import { browserUrlFromSession } from "../../layouts/main/sessionPolicy";
import { sessionToObjectStorageConfig } from "../../lib/objectStorage";
import { openExternalUrl } from "../../lib/sftp";
import { parseSessionOptions } from "../../lib/terminalProfile";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";
import type { SessionConfig } from "../../lib/ipc";
import type { WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";

/** Reuse the same protocol surfaces as Sessions, with a workspace-owned runtime id. */
export function WorkspaceAdditionalSessionPane({ session, tab, visible, password, onEditSession }: {
  session: SessionConfig;
  tab: WorkspaceIsolatedTab;
  visible: boolean;
  password?: string;
  onEditSession?: (sessionId: string) => void;
}) {
  const t = useT();
  const protocol = session.session_type;
  const options = parseSessionOptions(session.options_json);
  return (
    <div data-testid="workspace-session-pane" data-kind={protocol.toLowerCase()} data-session-id={session.id}
      className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
      {protocol === "Mail" && <MailClientTab tabId={tab.id} info={sessionToMailTabInfo(session, password, mailSmtpPasswordRefFromOptions(session) ?? undefined)} visible={visible}
        onEditSession={(id) => {
          if (onEditSession) { onEditSession(id); return; }
          useSessionStore.getState().setSelectedSession(id);
          useAppStore.getState().setActiveSideTab("sessions");
          useAppStore.getState().setSidebarCollapsed(false);
        }} />}
      {(protocol === "S3" || protocol === "AzureBlob") && <ObjectStorageBrowser sessionId={tab.id} config={sessionToObjectStorageConfig(session)} title={tab.title} />}
      {protocol === "Proxy" && <Suspense fallback={null}><ProxyTestTab info={{
        sessionId: session.id, proxyKind: options.proxyKind === "socks5" ? "socks5" : "http",
        host: session.host, port: session.port, username: session.username, password,
        testUrl: typeof options.testUrl === "string" ? options.testUrl : "www.google.com:443",
      }} /></Suspense>}
      {protocol === "Browser" && <div className="flex h-full flex-col items-center justify-center gap-3">
        <span>{session.host}</span>
        <button type="button" data-testid="workspace-open-browser" className="taomni-btn" onClick={() => {
          const url = browserUrlFromSession(session);
          if (url) void openExternalUrl(url).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
        }}>{t("platform.openInBrowser")}</button>
      </div>}
    </div>
  );
}
