import { Link2, Map, Maximize2, X } from "lucide-react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { useT } from "../../../lib/i18n";
import { submitSshAuthResponse } from "../../../lib/ipc";
import { loadResizableLayout, saveResizableLayout } from "../../../lib/resizableLayout";
import { type FileEntry, type FsSide } from "../../../lib/sftp";
import { useSftpController } from "../../../lib/sftpController";
import { type PaneSide } from "../../../stores/sftpStore";
import type { SftpPathMapping } from "../../../types";
import type { MenuItem } from "../../ContextMenu";
import { MfaPrompt } from "../../session/MfaPrompt";
import { ChmodDialog } from "../ChmodDialog";
import { FilePanel, isPreviewable } from "../FilePanel";
import { FileTransferQueue } from "../FileTransferQueue";
import { PathMappingsEditor, resolveRemoteByMapping } from "../PathMappingsEditor";
import { DownloadPrompt, OrientationToggle, PreviewModal } from "./Dialogs";
import { terminalPathForRemotePath } from "./preferences";
import { type FileBrowserProps, type Orientation } from "./types";
import { useFileBrowserConnection } from "./useFileBrowserConnection";
import { useFileBrowserTerminalSync } from "./useFileBrowserTerminalSync";
import { useFileBrowserTransfers } from "./useFileBrowserTransfers";

export interface FileBrowserViewProps {
  props: FileBrowserProps;
  t: ReturnType<typeof useT>;
  orientation: Orientation;
  setOrientation: (next: Orientation) => void;
  mappings: SftpPathMapping[];
  showMappings: boolean;
  setShowMappings: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  showCwdToolbar: boolean;
  terminalSync: ReturnType<typeof useFileBrowserTerminalSync>;
  setMappings: import("react").Dispatch<import("react").SetStateAction<SftpPathMapping[]>>;
  session: import("../../../stores/sftpStore").SftpSessionState;
  navigate: (sessionId: string, side: PaneSide, path: string) => Promise<void>;
  banner: string | null;
  connection: ReturnType<typeof useFileBrowserConnection>;
  setStatus: (message: string) => void;
  orientationScope: string;
  handleDoubleClick: (side: PaneSide, entry: FileEntry) => Promise<void>;
  remoteContext: (entry: FileEntry, _anchor: { x: number; y: number; }, selectedEntries: FileEntry[]) => MenuItem[];
  remoteEmptyContext: () => MenuItem[];
  transfers: ReturnType<typeof useFileBrowserTransfers>;
  remoteFilter: string;
  setRemoteFilter: import("react").Dispatch<import("react").SetStateAction<string>>;
  controller: ReturnType<typeof useSftpController>;
  deleteEntries: (entries: FileEntry[], side: FsSide) => Promise<void>;
  setChmodPrompt: import("react").Dispatch<import("react").SetStateAction<{ entries: FileEntry[]; side: FsSide; } | null>>;
  setPreviewing: import("react").Dispatch<import("react").SetStateAction<{ entry: FileEntry; side: FsSide; text: string; } | null>>;
  createFolder: (side: FsSide) => Promise<void>;
  createFile: (side: FsSide) => Promise<void>;
  localContext: (entry: FileEntry, _anchor: { x: number; y: number; }, selectedEntries: FileEntry[]) => MenuItem[];
  localEmptyContext: () => MenuItem[];
  handleOpenLocal: (entries: FileEntry[]) => Promise<void>;
  localFilter: string;
  setLocalFilter: import("react").Dispatch<import("react").SetStateAction<string>>;
  downloadPrompt: FileEntry | null;
  setDownloadPrompt: import("react").Dispatch<import("react").SetStateAction<FileEntry | null>>;
  handleDownloadConfirmed: (entry: FileEntry, openAfter: boolean) => void;
  chmodPrompt: { entries: FileEntry[]; side: FsSide; } | null;
  previewing: { entry: FileEntry; side: FsSide; text: string; } | null;
  confirmDialogRender: import("react").ReactNode;
  textInputDialogRender: import("react").ReactNode;
}

export function FileBrowserView(inputs: FileBrowserViewProps) {
  const {
    props,
    t,
    orientation,
    setOrientation,
    mappings,
    showMappings,
    setShowMappings,
    showCwdToolbar,
    terminalSync,
    setMappings,
    session,
    navigate,
    banner,
    connection,
    setStatus,
    orientationScope,
    handleDoubleClick,
    remoteContext,
    remoteEmptyContext,
    transfers,
    remoteFilter,
    setRemoteFilter,
    controller,
    deleteEntries,
    setChmodPrompt,
    setPreviewing,
    createFolder,
    createFile,
    localContext,
    localEmptyContext,
    handleOpenLocal,
    localFilter,
    setLocalFilter,
    downloadPrompt,
    setDownloadPrompt,
    handleDownloadConfirmed,
    chmodPrompt,
    previewing,
    confirmDialogRender,
    textInputDialogRender,
  } = inputs;
  const mfaPrompt = connection.mfaPrompt;

  return ((
    <div data-testid="sftp-browser" className="w-full h-full flex flex-col" style={{ background: "var(--taomni-bg)" }}>
      {props.showHeader && (
        <div
          className="h-6 px-2 flex items-center text-[11px] font-semibold border-b shrink-0 gap-1"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <span className="truncate flex-1">{props.title ?? t("fileBrowser.headerSftp")}</span>
          <OrientationToggle orientation={orientation} onChange={setOrientation} t={t} />
          {mappings.length > 0 && (
            <button
              data-testid="sftp-mappings-toggle"
              type="button"
              className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)]"
              title={t("fileBrowser.pathMappingsToggleTitle")}
              style={{ color: showMappings ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
              onClick={() => setShowMappings((v) => !v)}
            >
              <Map className="w-3 h-3" />
              <span className="text-[10px]">{t("fileBrowser.pathMappingsToggle")}</span>
              <span
                className="text-[10px] rounded-full px-1"
                style={{ background: "var(--taomni-accent)", color: "white", minWidth: "14px", textAlign: "center" }}
              >
                {mappings.length}
              </span>
            </button>
          )}
          {props.onDetach && (
            <button
              data-testid="sftp-detach"
              type="button"
              className="px-1 hover:bg-[var(--taomni-hover)] rounded"
              title={t("fileBrowser.detachOpenInWindow")}
              onClick={props.onDetach}
            >
              <Maximize2 className="w-3 h-3" />
            </button>
          )}
          {props.onClose && (
            <button
              data-testid="sftp-close"
              type="button"
              className="px-1 hover:bg-[var(--taomni-hover)] rounded"
              title={t("fileBrowser.hideSftpPanel")}
              onClick={props.onClose}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
      {showCwdToolbar && (
        <div
          className="text-[11px] px-2 py-1 border-b shrink-0 flex items-center gap-2"
          style={{
            borderColor: "var(--taomni-divider)",
            background: "var(--taomni-quick-bg)",
            color: "var(--taomni-text-muted)",
          }}
        >
          <span className="shrink-0">{t("fileBrowser.terminalCwdLabel")}</span>
          <span className="font-mono truncate flex-1" title={props.cwdHint ?? ""}>
            {props.cwdHint ?? t("fileBrowser.terminalCwdNotRequested")}
          </span>
          <button
            type="button"
            className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)] shrink-0"
            title={t("fileBrowser.terminalCwdQueryTitle")}
            onClick={terminalSync.syncToTerminalCwd}
            style={{ color: "var(--taomni-accent)" }}
          >
            <Link2 className="w-3 h-3" />
            <span>{t("fileBrowser.terminalCwdSync")}</span>
          </button>
          {!props.showHeader && (
            <OrientationToggle orientation={orientation} onChange={setOrientation} t={t} />
          )}
          {!props.showHeader && mappings.length > 0 && (
            <button
              data-testid="sftp-mappings-toggle"
              type="button"
              className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)] shrink-0"
              title={t("fileBrowser.pathMappingsToggleTitle")}
              style={{ color: showMappings ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
              onClick={() => setShowMappings((v) => !v)}
            >
              <Map className="w-3 h-3" />
              <span>{t("fileBrowser.pathMappingsToggle")}</span>
              <span
                className="text-[10px] rounded-full px-1"
                style={{ background: "var(--taomni-accent)", color: "white", minWidth: "14px", textAlign: "center" }}
              >
                {mappings.length}
              </span>
            </button>
          )}
        </div>
      )}
      {/* Standalone mappings toolbar — shown for non-header tabs that have mappings */}
      {!props.showHeader && !showCwdToolbar && mappings.length > 0 && (
        <div
          className="text-[11px] px-2 py-1 border-b shrink-0 flex items-center gap-2"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <OrientationToggle orientation={orientation} onChange={setOrientation} t={t} />
          <div className="flex-1" />
          <button
            data-testid="sftp-mappings-toggle"
            type="button"
            className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)]"
            title={t("fileBrowser.pathMappingsToggleTitle")}
            style={{ color: showMappings ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
            onClick={() => setShowMappings((v) => !v)}
          >
            <Map className="w-3 h-3" />
            <span>{t("fileBrowser.pathMappingsToggle")}</span>
            <span
              className="text-[10px] rounded-full px-1"
              style={{ background: "var(--taomni-accent)", color: "white", minWidth: "14px", textAlign: "center" }}
            >
              {mappings.length}
            </span>
          </button>
        </div>
      )}
      {/* Path mappings panel — shown when user toggles the Mappings button */}
      {showMappings && (
        <div
          data-testid="sftp-mappings-panel"
          className="border-b shrink-0 px-3 py-2"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <div className="text-[11px] font-semibold mb-1.5 flex items-center gap-1.5" style={{ color: "var(--taomni-accent)" }}>
            <Map className="w-3 h-3" />
            {t("fileBrowser.pathMappingsTitle")}
          </div>
          <PathMappingsEditor
            mappings={mappings}
            onChange={setMappings}
            compact
          />
          {mappings.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {mappings.map((m, i) => (
                m.localPath && m.remotePath ? (
                  <button
                    key={i}
                    type="button"
                    className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--taomni-hover)] inline-flex items-center gap-1"
                    style={{ border: "1px solid var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
                    title={`${t("fileBrowser.pathMappingsNavigateLocal")}: ${m.localPath}`}
                    onClick={() => {
                      if (m.localPath && session?.attached) {
                        void navigate(props.sessionId, "local", m.localPath);
                      }
                      if (m.remotePath && session?.attached) {
                        void navigate(props.sessionId, "remote", m.remotePath);
                      }
                    }}
                  >
                    <span className="font-mono truncate max-w-[120px]">{m.localPath}</span>
                    <span>→</span>
                    <span className="font-mono truncate max-w-[120px]">{m.remotePath}</span>
                  </button>
                ) : null
              ))}
            </div>
          )}
        </div>
      )}
      {banner && (
        <div
          className="text-[11px] px-2 py-1 border-b shrink-0"
          style={{
            borderColor: "var(--taomni-divider)",
            background: session?.error ? "#fde7e2" : "var(--taomni-quick-bg)",
            color: session?.error ? "#7a1f0a" : "var(--taomni-text)",
          }}
        >
          {banner}
          {session?.error && (
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => {
                void connection.reconnect(props.sessionId).catch((err) =>
                  setStatus(t("fileBrowser.statusReconnectFailed", { error: String(err) }))
                );
              }}
            >
              {t("fileBrowser.bannerRetry")}
            </button>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <PanelGroup
          // Re-mount the panel group when orientation flips so
          // react-resizable-panels reads new sizes cleanly.
          key={orientation}
          orientation={orientation}
          id={`sftp-browser-v2-${orientationScope}-${orientation}`}
          defaultLayout={loadResizableLayout(`sftp-browser-v2-${orientationScope}-${orientation}`, ["remote", "local"])}
          onLayoutChanged={saveResizableLayout(`sftp-browser-v2-${orientationScope}-${orientation}`)}
        >
          <Panel id="remote" defaultSize="50%" minSize="15%" className="flex flex-col min-h-0 min-w-0">
            <FilePanel
              sessionId={props.sessionId}
              side="remote"
              subtitle={`${props.username}@${props.host}`}
              detachable={props.detachable}
              onDetach={props.onDetach}
              onItemDoubleClick={(e) => void handleDoubleClick("remote", e)}
              onItemContext={remoteContext}
              onEmptyContext={remoteEmptyContext}
              acceptCrossPane
              onCrossPaneDrop={transfers.handleCrossPaneToRemote}
              filterText={remoteFilter}
              onFilterTextChange={setRemoteFilter}
              onDownloadSelected={(entries) => {
                const localDir = session?.local.path ?? "";
                for (const entry of entries) {
                  void controller.download(entry, localDir, { openAfter: false });
                }
              }}
              onUploadFromDisk={(files) => void transfers.handleLocalFiles(files)}
              onUploadPathsFromDisk={(paths) => void transfers.handleLocalPaths(paths)}
              onDeleteSelected={(entries) => {
                void deleteEntries(entries, "remote");
              }}
              onChmodSelected={(entries) => {
                if (entries.length === 0) return;
                setChmodPrompt({ entries, side: "remote" });
              }}
              onPreviewSelected={(entry) => {
                if (!isPreviewable(entry)) {
                  setStatus(t("fileBrowser.statusPreviewUnsupported", { name: entry.name }));
                  return;
                }
                void (async () => {
                  try {
                    const { sftpReadFileText } = await import("../../../lib/sftp");
                    const text = await sftpReadFileText(props.sessionId, entry.path, "remote");
                    setPreviewing({ entry, side: "remote", text });
                  } catch (err) {
                    setStatus(t("fileBrowser.statusPreviewFailed", { error: String(err) }));
                  }
                })();
              }}
              onNewFolder={() => void createFolder("remote")}
              onNewFile={() => void createFile("remote")}
              onOpenTerminalHere={props.onOpenTerminalHere
                ? (path) => props.onOpenTerminalHere?.(terminalPathForRemotePath(path, session?.homeDir))
                : undefined}
            />
          </Panel>
          <PanelResizeHandle
            className={
              orientation === "horizontal"
                ? "w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize"
                : "h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-row-resize"
            }
          />
          <Panel id="local" defaultSize="50%" minSize="15%" className="flex flex-col min-h-0 min-w-0">
            <FilePanel
              sessionId={props.sessionId}
              side="local"
              detachable={props.detachable}
              onDetach={props.onDetach}
              onItemDoubleClick={(e) => void handleDoubleClick("local", e)}
              onItemContext={localContext}
              onEmptyContext={localEmptyContext}
              acceptCrossPane
              onCrossPaneDrop={transfers.handleCrossPaneToLocal}
              onOpenLocalSelected={(entries) => void handleOpenLocal(entries)}
              onRevealInOs={(path) => {
                if (!path) return;
                void (async () => {
                  try {
                    const { sftpOpenPath } = await import("../../../lib/sftp");
                    await sftpOpenPath(path);
                  } catch (err) {
                    setStatus(t("fileBrowser.statusOpenFailed", { error: String(err) }));
                  }
                })();
              }}
              filterText={localFilter}
              onFilterTextChange={setLocalFilter}
              onUploadSelected={(entries) => {
                const remoteDir = session?.remote.path ?? "/";
                for (const entry of entries) {
                  // Use path mapping if available
                  const mappedRemote = resolveRemoteByMapping(entry.path, mappings);
                  void controller.upload(entry, mappedRemote ?? remoteDir);
                }
              }}
              onDeleteSelected={(entries) => {
                void deleteEntries(entries, "local");
              }}
              onChmodSelected={(entries) => {
                if (entries.length === 0) return;
                setChmodPrompt({ entries, side: "local" });
              }}
              onPreviewSelected={(entry) => {
                if (!isPreviewable(entry)) {
                  setStatus(t("fileBrowser.statusPreviewUnsupported", { name: entry.name }));
                  return;
                }
                void (async () => {
                  try {
                    const { sftpReadFileText } = await import("../../../lib/sftp");
                    const text = await sftpReadFileText(props.sessionId, entry.path, "local");
                    setPreviewing({ entry, side: "local", text });
                  } catch (err) {
                    setStatus(t("fileBrowser.statusPreviewFailed", { error: String(err) }));
                  }
                })();
              }}
              onNewFolder={() => void createFolder("local")}
              onNewFile={() => void createFile("local")}
            />
          </Panel>
        </PanelGroup>
      </div>
      <FileTransferQueue
        sessionId={props.sessionId}
        showCrossHostBanner
        onCancel={(id) => void controller.cancelTransfer(id)}
        onPause={(id) => void controller.pauseTransfer(id)}
        onResume={(id) => void controller.resumeTransfer(id)}
        onRetry={(id) => void controller.retryTransfer(id)}
      />

      {downloadPrompt && (
        <DownloadPrompt
          entry={downloadPrompt}
          localDir={session?.local.path ?? ""}
          onCancel={() => setDownloadPrompt(null)}
          onDownload={(openAfter) => handleDownloadConfirmed(downloadPrompt, openAfter)}
        />
      )}

      {chmodPrompt && (
        <ChmodDialog
          entries={chmodPrompt.entries}
          onCancel={() => setChmodPrompt(null)}
          onApply={(mode, recursive) => {
            const { entries, side } = chmodPrompt;
            for (const entry of entries) {
              if (recursive && entry.fileType === "dir") {
                void controller.chmodRecursive(entry.path, mode, side);
              } else {
                void controller.chmod(entry.path, mode, side);
              }
            }
            setChmodPrompt(null);
          }}
        />
      )}

      {previewing && (
        <PreviewModal
          path={previewing.entry.path}
          name={previewing.entry.name}
          text={previewing.text}
          onClose={() => setPreviewing(null)}
        />
      )}

      {confirmDialogRender}
      {textInputDialogRender}

      {mfaPrompt && (
        <MfaPrompt
          host={props.host}
          username={props.username}
          request={mfaPrompt}
          onSubmit={(responses) => {
            void submitSshAuthResponse(mfaPrompt.requestId, responses).catch(() => { });
            connection.pendingMfaRequestIdRef.current = null;
            connection.setMfaPrompt(null);
          }}
          onCancel={() => {
            void submitSshAuthResponse(mfaPrompt.requestId, null).catch(() => { });
            connection.pendingMfaRequestIdRef.current = null;
            connection.setMfaPrompt(null);
          }}
        />
      )}
    </div>
  ));
}
