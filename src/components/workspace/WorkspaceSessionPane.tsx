import { lazy, Suspense } from "react";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { FileBrowser } from "../filebrowser/FileBrowser";
import { LocalFileBrowserPanel } from "../filebrowser/LocalFileBrowserPanel";
import { getSessionTerminalProfile, loadTerminalDefaultProfile, parseSessionOptions } from "../../lib/terminalProfile";
import { commandTerminalFromSession, localShellSelectionFromSession } from "../../layouts/main/sessionPolicy";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";
import { parseRdpOptions } from "../../types/rdp";
import { parseVncViewerOptions } from "../../lib/vncOptions";
import { sessionToDbConnectInfo } from "../../layouts/main/databaseSession";
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

function sshAuth(session: SessionConfig): { method: string; data: string | null } {
  const method = typeof session.auth_method === "string" ? session.auth_method : "PrivateKey";
  const data = typeof session.auth_method === "object" && session.auth_method && "PrivateKey" in session.auth_method
    ? session.auth_method.PrivateKey.key_path
    : null;
  return { method, data };
}

export interface WorkspaceSessionPaneProps {
  workspace: PlatformWorkspace;
  tab: WorkspaceIsolatedTab;
  visible: boolean;
}

/**
 * Isolated session surface of the Workspaces canvas (AC-07).
 *
 * The pane reuses the production protocol components unchanged, so context
 * menus, toolbars and shortcuts inside a workspace session are the same as in
 * Sessions mode. Its runtime id is the workspace tab id, never an app tab id.
 */
export function WorkspaceSessionPane({ tab, visible }: WorkspaceSessionPaneProps) {
  const session = useSessionStore((state) => (tab.sessionId ? state.sessions.find((entry) => entry.id === tab.sessionId) : undefined));
  const setActiveSideTab = useAppStore((s) => s.setActiveSideTab);
  const protocol = session?.session_type ?? tab.protocol ?? "Local";

  if (protocol === "Local" || !session || commandTerminalFromSession(session)) {
    return (
      <div data-testid="workspace-session-pane" data-kind="terminal" className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <TerminalPanel
          tabId={tab.id}
          tabTitle={tab.title}
          visible={visible}
          workspaceRoot={undefined}
          commandTerminal={session ? commandTerminalFromSession(session) ?? undefined : undefined}
          localShell={session && protocol === "Local" ? localShellSelectionFromSession(session) : undefined}
          terminalProfile={session ? getSessionTerminalProfile(session.options_json) ?? loadTerminalDefaultProfile() : undefined}
          preserveSessionOnUnmount={false}
        />
      </div>
    );
  }

  if (protocol === "SSH") {
    const auth = sshAuth(session);
    return (
      <div data-testid="workspace-session-pane" data-kind="terminal" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <TerminalPanel
          tabId={tab.id}
          tabTitle={tab.title}
          visible={visible}
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
    const auth = sshAuth(session);
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
            password={undefined}
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
            password={undefined}
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
          <RedisClientTab tabId={tab.id} info={sessionToDbConnectInfo(session)} visible={visible} />
        </Suspense>
      </div>
    );
  }

  if (protocol === "HBaseShell") {
    return (
      <div data-testid="workspace-session-pane" data-kind="hbase" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <Suspense fallback={<DbLoadingPanel />}>
          <HBaseShellTab tabId={tab.id} info={sessionToDbConnectInfo(session) as never} visible={visible} />
        </Suspense>
      </div>
    );
  }

  if (DB_ENGINES.has(protocol)) {
    return (
      <div data-testid="workspace-session-pane" data-kind="database" data-session-id={session.id} className="h-full min-h-0 w-full" style={{ display: visible ? "block" : "none" }}>
        <Suspense fallback={<DbLoadingPanel />}>
          <DbClientTab tabId={tab.id} info={sessionToDbConnectInfo(session)} visible={visible} />
        </Suspense>
      </div>
    );
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
