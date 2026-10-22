import { useCallback } from "react";
import { sessionToObjectStorageConfig } from "../../lib/objectStorage";
import { parseVncViewerOptions, writeVncViewerOptions } from "../../lib/vncOptions";
import type { VncSessionProperties } from "../../components/vnc/VncPropertiesDialog";
import type { Tab, DbConnectInfo } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { type SessionConfig } from "../../lib/ipc";
import { vaultPut } from "../../lib/ipc";
import { ensureVaultReady } from "../../lib/vaultGate";
import { parseSessionOptions } from "../../lib/terminalProfile";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";
import { parsePathMappings } from "../../components/filebrowser/PathMappingsEditor";
import { parseRdpOptions } from "../../types/rdp";
import { t as tr } from "../../lib/i18n";
import { SAVED_PASSWORD_VAULT_REASON_KEY, passwordRefFromOptions } from "./authentication";
import { sessionToDbConnectInfo, sessionToHBaseConnectInfo } from "./databaseSession";
import { sessionToMailTabInfo } from "./mailSession";


export interface UseProtocolTabsContext {
  addTab: (tab: Tab) => void;
  markConnected: (id: string) => Promise<void>;
  updateSession: (config: SessionConfig) => Promise<void>;
  setStatusMessage: (message: string) => void;
  tabsRef: import("react").RefObject<Tab[]>;
  setActiveTab: (id: string) => void;
}

export function useProtocolTabs(context: UseProtocolTabsContext) {
  const { addTab, markConnected, updateSession, setStatusMessage, tabsRef, setActiveTab } = context;

  const openSftpTab = useCallback((session: SessionConfig, authMethod: string, authData: string | null) => {
    const tabId = `sftp-${session.id}-${Date.now()}`;
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    const pathMappings = parsePathMappings(session.options_json);
    addTab({
      id: tabId,
      type: "sftp",
      title: `${session.name || `${session.username ?? "user"}@${session.host}`} (SFTP)`,
      sessionId: session.id,
      closable: true,
      sftp: {
        sessionId: tabId,
        host: session.host,
        port: session.port,
        username: session.username ?? "root",
        authMethod,
        authData,
        networkSettingsJson: JSON.stringify(ns),
        attachedToTerminal: false,
        pathMappings: pathMappings.length > 0 ? pathMappings : undefined,
      },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openVncTab = useCallback((session: SessionConfig, password?: string) => {
    const id = `vnc-${session.id}-${Date.now()}`;
    const options = parseSessionOptions(session.options_json);
    const rawPolicy = typeof options.vncSecurityPolicy === "string" ? options.vncSecurityPolicy : "prefer-encryption";
    const securityPolicy = rawPolicy === "require-encryption" || rawPolicy === "legacy-compatible" || rawPolicy === "allow-none"
      || rawPolicy === "prefer-off"
      ? rawPolicy
      : "prefer-encryption";
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    addTab({
      id,
      type: "vnc",
      title: session.name || `${session.host}:${session.port}`,
      sessionId: session.id,
      closable: true,
      vnc: {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username,
        password,
        networkSettingsJson: JSON.stringify(ns),
        securityPolicy,
        viewOnly: options.vncViewOnly === true,
        clipboardPolicy:
          options.vncClipboardPolicy === "disabled" || options.vncClipboardPolicy === "client-to-server" || options.vncClipboardPolicy === "server-to-client"
            ? options.vncClipboardPolicy
            : "bidirectional",
        viewerOptions: parseVncViewerOptions(options),
      },
    });
  }, [addTab]);

  // VNC-CONN-001: Properties changed in a VNC session persist to the saved
  // session (like RealVNC's address-book entry) and to the tab.
  const persistVncProperties = useCallback(async (tabId: string, sessionId: string, properties: VncSessionProperties) => {
    useAppStore.getState().updateTabVnc(tabId, {
      viewOnly: properties.viewOnly,
      clipboardPolicy: properties.clipboardPolicy,
      viewerOptions: properties.viewer,
    });
    const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
    if (!session) return;
    const options = writeVncViewerOptions(parseSessionOptions(session.options_json), properties.viewer);
    options.vncViewOnly = properties.viewOnly;
    options.vncClipboardPolicy = properties.clipboardPolicy;
    try {
      await updateSession({ ...session, options_json: JSON.stringify(options) });
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [setStatusMessage, updateSession]);

  // "Remember password" in the in-session authentication form stores the
  // password in the vault and references it from the session.
  const rememberVncCredentials = useCallback(async (tabId: string, sessionId: string, password: string) => {
    const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
    if (!session) return;
    const ready = await ensureVaultReady(tr(SAVED_PASSWORD_VAULT_REASON_KEY));
    if (!ready) return;
    try {
      const label = `${session.username || "user"}@${session.host || "?"}:${session.port}`;
      const result = await vaultPut("vnc-password", label, password);
      const opts = parseSessionOptions(session.options_json);
      await updateSession({ ...session, options_json: JSON.stringify({ ...opts, passwordRef: result.reference }) });
      useAppStore.getState().updateTabVnc(tabId, { password: result.reference });
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    }
  }, [setStatusMessage, updateSession]);

  const openRdpTab = useCallback((session: SessionConfig, password?: string) => {
    const id = `rdp-${session.id}-${Date.now()}`;
    const opts = parseRdpOptions(session.options_json);
    const ns = toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json));
    addTab({
      id,
      type: "rdp",
      title: session.name || `${session.host}:${session.port}`,
      sessionId: session.id,
      closable: true,
      rdp: {
        sessionId: session.id,
        host: session.host,
        port: session.port,
        username: session.username,
        password,
        options: opts,
        networkSettingsJson: JSON.stringify(ns),
      },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openFileBrowserTab = useCallback((title: string, initialPath: string, sessionId?: string) => {
    const id = `file-${sessionId ?? "ad-hoc"}-${Date.now()}`;
    addTab({
      id,
      type: "file-browser",
      title,
      sessionId,
      closable: true,
      fileBrowser: { initialPath },
    });
  }, [addTab]);

  const openDbTab = useCallback((session: SessionConfig, password?: string) => {
    const engine = session.session_type as DbConnectInfo["engine"];
    const isRedis = engine === "Redis";
    const id = `${isRedis ? "redis" : "database"}-${session.id}-${Date.now()}`;
    const info = sessionToDbConnectInfo(session, password);
    const prestoPath = info.engine === "Presto"
      ? [info.catalog, info.database].filter(Boolean).join(".")
      : info.database;
    const title = `${engine} ${session.host}:${session.port}${prestoPath ? `/${prestoPath}` : ""}`;
    addTab({
      id,
      type: isRedis ? "redis" : "database",
      title,
      sessionId: session.id,
      closable: true,
      db: info,
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openHBaseShellTab = useCallback((session: SessionConfig, password?: string) => {
    const id = `hbase-shell-${session.id}-${Date.now()}`;
    const info = sessionToHBaseConnectInfo(session, password);
    // Native mode may have no host/port (it bootstraps via ZK quorum or
    // hbase-site.xml), so build a sensible endpoint label per mode.
    const endpointLabel =
      info.connectionMode === "native"
        ? info.zkQuorum?.split(",")[0]?.trim() ||
        (session.host ? `${session.host}:${session.port}` : "") ||
        (info.hbaseSitePath ? "hbase-site.xml" : "ZooKeeper")
        : `${session.host}:${session.port}`;
    const title = `HBase ${endpointLabel}${info.namespace ? `/${info.namespace}` : ""}`;
    addTab({
      id,
      type: "hbase-shell",
      title,
      sessionId: session.id,
      closable: true,
      hbase: info,
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openProxyTestTab = useCallback((session: SessionConfig) => {
    const id = `proxy-test-${session.id}-${Date.now()}`;
    const options = parseSessionOptions(session.options_json);
    const proxyKind = (options.proxyKind === "socks5" ? "socks5" : "http") as "http" | "socks5";
    const title = `${proxyKind === "http" ? "HTTP" : "SOCKS5"} ${session.host}:${session.port}`;
    addTab({
      id,
      type: "proxy-test",
      title,
      sessionId: session.id,
      closable: true,
      proxyTest: {
        sessionId: session.id,
        proxyKind,
        host: session.host,
        port: session.port,
        username: session.username,
        password: passwordRefFromOptions(session) || undefined,
        testUrl: typeof options.testUrl === "string" ? options.testUrl : "www.google.com:443",
      },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openObjectStorageTab = useCallback((session: SessionConfig) => {
    const id = `object-storage-${session.id}-${Date.now()}`;
    const config = sessionToObjectStorageConfig(session);
    const title = session.name || session.host || "Object Storage";
    addTab({
      id,
      type: "object-storage",
      title,
      sessionId: session.id,
      closable: true,
      // The browser keys its live store by the tab session id (not the saved
      // session id) so two tabs for the same saved session stay independent.
      objectStorage: { sessionId: id, config },
    });
    void markConnected(session.id);
  }, [addTab, markConnected]);

  const openMailTab = useCallback((session: SessionConfig, password?: string, smtpPassword?: string) => {
    const existing = tabsRef.current.find((tab) => tab.type === "mail" && tab.sessionId === session.id);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    const id = `mail-${session.id}-${Date.now()}`;
    const info = sessionToMailTabInfo(session, password, smtpPassword);
    const title = session.name || info.emailAddress || `Mail ${session.host}`;
    addTab({
      id,
      type: "mail",
      title,
      sessionId: session.id,
      closable: true,
      mail: info,
    });
    void markConnected(session.id);
  }, [addTab, markConnected, setActiveTab]);
  return { openFileBrowserTab, openSftpTab, openVncTab, openRdpTab, openDbTab, openHBaseShellTab, openProxyTestTab, openObjectStorageTab, openMailTab, persistVncProperties, rememberVncCredentials };
}
