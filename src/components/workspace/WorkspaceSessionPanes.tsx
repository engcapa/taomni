import { Suspense } from "react";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { FileBrowser } from "../filebrowser/FileBrowser";
import { DbClientTab, DbLoadingPanel, HBaseShellTab, RedisClientTab, RdpPanel, VncPanel } from "../../layouts/main/panels";
import type { WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";

/**
 * Isolated session panes for workspace tabs (v6.1 TASK-07). Each pane reuses
 * the production session components with its own runtime tab id, so the
 * backend session lifecycle (terminal PTY, SFTP channel, DB connection) is
 * fully independent from the Sessions-mode tabs of the same session config.
 */
export function WorkspaceSessionPane({ tab, visible }: { tab: WorkspaceIsolatedTab; visible: boolean }) {
  switch (tab.kind) {
    case "terminal":
      return (
        <TerminalPanel
          tabId={tab.id}
          tabTitle={tab.title}
          ssh={tab.ssh}
          commandTerminal={tab.commandTerminal}
          localShell={tab.localShell}
          terminalProfile={tab.terminalProfile}
          visible={visible}
          activeForShortcuts={visible}
        />
      );
    case "sftp":
      if (!tab.sftp) return null;
      return (
        <FileBrowser
          sessionId={tab.sftp.sessionId}
          host={tab.sftp.host}
          port={tab.sftp.port}
          username={tab.sftp.username}
          authMethod={tab.sftp.authMethod}
          authData={tab.sftp.authData}
          networkSettingsJson={tab.sftp.networkSettingsJson ?? null}
          initialPath={tab.sftp.initialPath}
          pathMappings={tab.sftp.pathMappings}
        />
      );
    case "database":
      if (!tab.db) return null;
      return (
        <Suspense fallback={<DbLoadingPanel />}>
          <DbClientTab tabId={tab.id} info={tab.db} visible={visible} />
        </Suspense>
      );
    case "redis":
      if (!tab.db) return null;
      return (
        <Suspense fallback={<DbLoadingPanel />}>
          <RedisClientTab tabId={tab.id} info={tab.db} visible={visible} />
        </Suspense>
      );
    case "hbase-shell":
      if (!tab.hbase) return null;
      return (
        <Suspense fallback={<DbLoadingPanel />}>
          <HBaseShellTab tabId={tab.id} info={tab.hbase} visible={visible} />
        </Suspense>
      );
    case "vnc":
      if (!tab.vnc) return null;
      return (
        <Suspense fallback={null}>
          <VncPanel
            tabId={tab.id}
            host={tab.vnc.host}
            port={tab.vnc.port}
            username={tab.vnc.username}
            password={tab.vnc.password}
            networkSettingsJson={tab.vnc.networkSettingsJson}
            securityPolicy={tab.vnc.securityPolicy}
            viewOnly={tab.vnc.viewOnly}
            clipboardPolicy={tab.vnc.clipboardPolicy}
            viewerOptions={tab.vnc.viewerOptions}
            visible={visible}
          />
        </Suspense>
      );
    case "rdp":
      if (!tab.rdp) return null;
      return (
        <Suspense fallback={null}>
          <RdpPanel
            tabId={tab.id}
            host={tab.rdp.host}
            port={tab.rdp.port}
            username={tab.rdp.username}
            password={tab.rdp.password}
            options={tab.rdp.options}
            networkSettingsJson={tab.rdp.networkSettingsJson}
            visible={visible}
          />
        </Suspense>
      );
    default:
      return null;
  }
}
