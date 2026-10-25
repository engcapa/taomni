import { lazy, Suspense, useEffect } from "react";
import { useT } from "../../lib/i18n";
import { useWorkspaceSessionAccess } from "./useWorkspaceSessionAccess";
import { WorkspaceAdditionalSessionPane } from "./WorkspaceAdditionalSessionPane";
import { parsePathMappings } from "../filebrowser/PathMappingsEditor";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { FileBrowser } from "../filebrowser/FileBrowser";
import { LocalFileBrowserPanel } from "../filebrowser/LocalFileBrowserPanel";
import { getSessionTerminalProfile, loadTerminalDefaultProfile, parseSessionOptions } from "../../lib/terminalProfile";
import { commandTerminalFromSession, localShellSelectionFromSession } from "../../layouts/main/sessionPolicy";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";
import { parseRdpOptions } from "../../types/rdp";
import { parseVncViewerOptions } from "../../lib/vncOptions";
import { sessionToDbConnectInfo, sessionToHBaseConnectInfo } from "../../layouts/main/databaseSession";
import type { SessionConfig } from "../../lib/ipc";
import { useAppStore } from "../../stores/appStore";
import type { PlatformWorkspace, WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";
import { useSessionStore } from "../../stores/sessionStore";
import {
  DbLoadingPanel,
  HBaseShellTab,
  RedisClientTab,
  RdpLoadingPanel,
  VncLoadingPanel,
} from "../../layouts/main/panels";

const DbClientTab = lazy(() => import("../database/DbClientTab"));
const RdpPanel = lazy(() => import("../rdp/RdpPanel"));
const VncPanel = lazy(() => import("../vnc/VncPanel"));

const DB_ENGINES = new Set([
  "MySQL",
  "MariaDB",
  "PostgreSQL",
  "PanWeiDB",
  "Oracle",
  "SQLServer",
  "StarRocks",
  "ClickHouse",
  "Presto",
]);

function networkSettingsJson(session: SessionConfig): string {
  return JSON.stringify(toNetworkSettingsPayload(getSessionNetworkSettings(session.options_json)));
}

export interface WorkspaceSessionPaneProps {
  workspace: PlatformWorkspace;
  tab: WorkspaceIsolatedTab;
  visible: boolean;
  active?: boolean;
  onEditSession?: (sessionId: string) => void;
}

/**
 * Isolated session surface of the Workspaces canvas (AC-07).
 *
 * The pane reuses the production protocol components unchanged, so context
 * menus, toolbars and shortcuts inside a workspace session are the same as in
 * Sessions mode. Its runtime id is the workspace tab id, never an app tab id.
 */
export function WorkspaceSessionPane(props: WorkspaceSessionPaneProps) {
  const { tab, visible } = props;
  const session = useSessionStore((state) => state.sessions.find((entry) => entry.id === tab.sessionId));
  const loaded = useSessionStore((state) => state.loaded);
  const loading = useSessionStore((state) => state.loading);
  const loadError = useSessionStore((state) => state.loadError);
  const t = useT();
  if (tab.sessionId && !session) {
    const waiting = !loaded && !loadError;
    return (
      <div data-testid="workspace-session-unavailable" data-state={waiting ? "loading" : loadError ? "failed" : "missing"}
        className="flex h-full flex-col items-center justify-center gap-3 p-4" style={{ display: visible ? "flex" : "none" }}>
        <span>{waiting ? t("common.loading") : loadError ?? t("platform.savedSessionMissing")}</span>
        {!waiting && <button type="button" data-testid="workspace-session-retry" className="taomni-btn" disabled={loading}
          onClick={() => void useSessionStore.getState().loadSessions()}>{t("platform.retrySessions")}</button>}
      </div>
    );
  }
  if (session) return <SavedWorkspaceSession key={tab.id + session.id} {...props} session={session} />;
  return <WorkspaceProtocolPane {...props} />;
}

function SavedWorkspaceSession(props: WorkspaceSessionPaneProps & { session: SessionConfig }) {
  const access = useWorkspaceSessionAccess(props.session, props.visible);
  if (access.gate) return access.gate;
  return <WorkspaceProtocolPane {...props} session={access.session} auth={access.auth} password={access.password} />;
}

function WorkspaceProtocolPane({ tab, visible, active = visible, session, auth, password, onEditSession }: WorkspaceSessionPaneProps & {
  session?: SessionConfig;
  auth?: { method: string; data: string | null };
  password?: string;
}) {
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const protocol = session?.session_type ?? tab.protocol ?? "Local";
  useEffect(() => {
    if (session) void useSessionStore.getState().markConnected(session.id)
      .catch((error) => useAppStore.getState().setStatusMessage(String(error)));
  }, [session?.id]);

  if ((protocol === "Local" || protocol === "LocalShell") || !session || commandTerminalFromSession(session)) {
    return (
      <div data-testid="workspace-session-pane" data-kind="terminal" data-session-id={session?.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <TerminalPanel
          tabId={tab.id}
          tabTitle={tab.title}
          initialCwd={tab.terminalInitialCwd}
          visible={visible}
          activeForShortcuts={active}
          workspaceRoot={undefined}
          commandTerminal={session ? commandTerminalFromSession(session) ?? undefined : undefined}
          localShell={session && (protocol === "Local" || protocol === "LocalShell") ? localShellSelectionFromSession(session) : undefined}
          terminalProfile={session ? getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile() : undefined}
          preserveSessionOnUnmount={false}
        />
      </div>
    );
  }

  if (protocol === "SSH") {
    if (!auth) return null;
    return (
      <div data-testid="workspace-session-pane" data-kind="terminal" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <TerminalPanel
          tabId={tab.id}
          tabTitle={tab.title}
          initialCwd={tab.terminalInitialCwd}
          visible={visible}
          activeForShortcuts={active}
          terminalProfile={getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile()}
          ssh={{
            sessionId: session.id,
            host: session.host,
            port: session.port,
            username: session.username ?? "root",
            authMethod: auth.method,
            authData: auth.data,
            optionsJson: session.options_json,
          }}
        />
      </div>
    );
  }

  if (protocol === "SFTP") {
    if (!auth) return null;
    return (
      <div data-testid="workspace-session-pane" data-kind="sftp" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <FileBrowser
          sessionId={tab.id}
          host={session.host}
          port={session.port}
          username={session.username ?? "root"}
          authMethod={auth.method}
          authData={auth.data}
          networkSettingsJson={networkSettingsJson(session)}
          pathMappings={parsePathMappings(session.options_json)}
        />
      </div>
    );
  }

  if (protocol === "File") {
    return (
      <div data-testid="workspace-session-pane" data-kind="file-browser" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <LocalFileBrowserPanel tabId={tab.id} initialPath={session.host} />
      </div>
    );
  }

  if (protocol === "RDP") {
    const options = parseRdpOptions(session.options_json);
    return (
      <div data-testid="workspace-session-pane" data-kind="rdp" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <Suspense fallback={<RdpLoadingPanel />}>
          <RdpPanel
            tabId={tab.id}
            host={session.host}
            port={session.port}
            username={session.username ?? undefined}
            password={password}
            options={options}
            networkSettingsJson={networkSettingsJson(session)}
            visible={visible}
          />
        </Suspense>
      </div>
    );
  }

  if (protocol === "VNC") {
    const options = parseSessionOptions(session.options_json);
    const rawPolicy = typeof options.vncSecurityPolicy === "string" ? options.vncSecurityPolicy : "prefer-encryption";
    const securityPolicy = ["require-encryption", "legacy-compatible", "allow-none", "prefer-off"].includes(rawPolicy)
      ? rawPolicy as "require-encryption" | "legacy-compatible" | "allow-none" | "prefer-off"
      : "prefer-encryption";
    const clipboardPolicy = options.vncClipboardPolicy === "disabled"
      || options.vncClipboardPolicy === "client-to-server"
      || options.vncClipboardPolicy === "server-to-client"
      ? options.vncClipboardPolicy
      : "bidirectional";
    return (
      <div data-testid="workspace-session-pane" data-kind="vnc" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <Suspense fallback={<VncLoadingPanel />}>
          <VncPanel
            tabId={tab.id}
            host={session.host}
            port={session.port}
            username={session.username ?? undefined}
            password={password}
            networkSettingsJson={networkSettingsJson(session)}
            securityPolicy={securityPolicy}
            viewOnly={options.vncViewOnly === true}
            clipboardPolicy={clipboardPolicy}
            viewerOptions={parseVncViewerOptions(options)}
            visible={visible}
          />
        </Suspense>
      </div>
    );
  }

  if (protocol === "Redis") {
    return (
      <div data-testid="workspace-session-pane" data-kind="redis" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <Suspense fallback={<DbLoadingPanel />}>
          <RedisClientTab tabId={tab.id} info={sessionToDbConnectInfo(session, password)} visible={visible} />
        </Suspense>
      </div>
    );
  }

  if (protocol === "HBaseShell") {
    return (
      <div data-testid="workspace-session-pane" data-kind="hbase" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <Suspense fallback={<DbLoadingPanel />}>
          <HBaseShellTab tabId={tab.id} info={sessionToHBaseConnectInfo(session, password)} visible={visible} />
        </Suspense>
      </div>
    );
  }

  if (DB_ENGINES.has(protocol)) {
    return (
      <div data-testid="workspace-session-pane" data-kind="database" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <Suspense fallback={<DbLoadingPanel />}>
          <DbClientTab tabId={tab.id} info={sessionToDbConnectInfo(session, password)} visible={visible} />
        </Suspense>
      </div>
    );
  }

  if (["Mail", "Browser", "Proxy", "S3", "AzureBlob"].includes(protocol)) {
    return <WorkspaceAdditionalSessionPane session={session} tab={tab} visible={visible} password={password} onEditSession={onEditSession} />;
  }

  return (
    <div data-testid="workspace-session-pane" data-kind="unsupported" className="flex h-full flex-col items-center justify-center gap-2 p-6">
      <div className="text-[13px] font-semibold">{tab.title}</div>
      <div className="text-[11.5px]" style={{ color: "var(--taomni-text-muted)" }}>
        {protocol} · {session.host}
      </div>
      <button type="button" className="taomni-btn h-7 px-2" onClick={() => setActiveSideTab("sessions")}>
        Open in Sessions mode
      </button>
    </div>
  );
}
