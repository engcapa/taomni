import { useCallback, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { effectiveFileType, type FileEntry, type FsSide } from "../../lib/sftp";
import { useSftpController } from "../../lib/sftpController";
import { loadSftpPreferences } from "../../lib/sftpPreferences";
import { useAppStore } from "../../stores/appStore";
import { useSftpStore, type PaneSide } from "../../stores/sftpStore";
import type { SftpPathMapping } from "../../types";
import type { MenuItem } from "../ContextMenu";
import { useConfirmDialog, useTextInputDialog } from "../sidebar/ConfirmDialog";
import { FileBrowserView } from "./browser/FileBrowserView";
import { loadOrientation, saveOrientation } from "./browser/preferences";
import { type FileBrowserProps, type Orientation } from "./browser/types";
import { useFileBrowserConnection } from "./browser/useFileBrowserConnection";
import { useFileBrowserTerminalSync } from "./browser/useFileBrowserTerminalSync";
import { useFileBrowserTransfers } from "./browser/useFileBrowserTransfers";
import { resolveRemoteByMapping } from "./PathMappingsEditor";

export function FileBrowser(props: FileBrowserProps) {
  const t = useT();
  const session = useSftpStore((s) => s.sessions[props.sessionId]);
  const navigate = useSftpStore((s) => s.navigate);
  const setStatus = useAppStore((s) => s.setStatusMessage);
  const controller = useSftpController(props.sessionId);
  const { confirm: confirmDialog, render: confirmDialogRender } = useConfirmDialog();
  const { promptText, render: textInputDialogRender } = useTextInputDialog();
  const connection = useFileBrowserConnection({
    props,
    navigate,
    setStatus,
    t,
  });

  const [downloadPrompt, setDownloadPrompt] = useState<FileEntry | null>(null);
  const [previewing, setPreviewing] = useState<{ entry: FileEntry; side: FsSide; text: string; } | null>(null);
  const [chmodPrompt, setChmodPrompt] = useState<{ entries: FileEntry[]; side: FsSide; } | null>(null);
  // Per-pane filter strings (case-insensitive substring match).
  const [localFilter, setLocalFilter] = useState("");
  const [remoteFilter, setRemoteFilter] = useState("");
  // Path mappings panel state — local editable copy derived from props
  const [showMappings, setShowMappings] = useState(false);
  const [mappings, setMappings] = useState<SftpPathMapping[]>(props.pathMappings ?? []);

  const orientationScope = props.orientationScope ?? props.sessionId;
  const [orientation, setOrientationState] = useState<Orientation>(() =>
    loadOrientation(orientationScope, props.defaultOrientation ?? "horizontal"),
  );
  const setOrientation = useCallback(
    (next: Orientation) => {
      setOrientationState(next);
      saveOrientation(orientationScope, next);
    },
    [orientationScope],
  );
  const terminalSync = useFileBrowserTerminalSync({
    props,
    setStatus,
    t,
    session,
    navigate,
  });

  const handleDoubleClick = useCallback(
    async (side: PaneSide, entry: FileEntry) => {
      if (effectiveFileType(entry) === "dir") {
        await navigate(props.sessionId, side, entry.path);
        if (side === "remote") props.onTerminalSync?.(entry.path);
        return;
      }
      if (side === "remote") {
        setDownloadPrompt(entry);
        return;
      }
      // Local file: open or upload based on global SFTP preference (default: open).
      const { localDoubleClickAction } = loadSftpPreferences();
      if (localDoubleClickAction === "upload") {
        const remoteDir = session?.remote.path ?? "/";
        const mappedRemote = resolveRemoteByMapping(entry.path, mappings);
        void controller.upload(entry, mappedRemote ?? remoteDir);
        return;
      }
      try {
        const { sftpOpenPath } = await import("../../lib/sftp");
        await sftpOpenPath(entry.path);
      } catch (err) {
        setStatus(t("fileBrowser.statusFailedToOpen", { name: entry.name, error: String(err) }));
      }
    },
    [
      controller,
      mappings,
      navigate,
      props.sessionId,
      props.onTerminalSync,
      session?.remote.path,
      setStatus,
      t,
    ],
  );

  const handleDownloadConfirmed = useCallback(
    (entry: FileEntry, openAfter: boolean) => {
      const localDir = session?.local.path ?? "";
      void controller.download(entry, localDir, { openAfter });
      setDownloadPrompt(null);
    },
    [controller, session?.local.path],
  );

  const handleOpenLocal = useCallback(
    async (entries: FileEntry[]) => {
      const { sftpOpenPath } = await import("../../lib/sftp");
      for (const entry of entries) {
        if (effectiveFileType(entry) === "dir") {
          await navigate(props.sessionId, "local", entry.path);
          return;
        }
        try {
          await sftpOpenPath(entry.path);
        } catch (err) {
          setStatus(t("fileBrowser.statusFailedToOpen", { name: entry.name, error: String(err) }));
        }
      }
    },
    [navigate, props.sessionId, setStatus, t],
  );

  const renameEntry = useCallback(
    async (entry: FileEntry, side: FsSide) => {
      const next = await promptText({
        title: t("fileBrowser.promptRenameTitle"),
        initialValue: entry.name,
      });
      if (next && next !== entry.name) {
        void controller.rename(entry.path, next, side);
      }
    },
    [controller, promptText, t],
  );

  const deleteEntries = useCallback(
    async (entries: FileEntry[], side: FsSide) => {
      if (entries.length === 0) return;
      const summary = entries.length === 1
        ? entries[0].name
        : t("fileBrowser.summaryItems", { count: entries.length });
      const message = side === "remote"
        ? t("fileBrowser.confirmDeleteRemoteSummary", { summary })
        : t("fileBrowser.confirmDeleteSummary", { summary });
      const confirmed = await confirmDialog({
        message,
        confirmLabel: t("common.delete"),
        danger: true,
      });
      if (!confirmed) return;
      for (const entry of entries) {
        void controller.remove(entry.path, side, true);
      }
    },
    [confirmDialog, controller, t],
  );

  const createFolder = useCallback(
    async (side: FsSide) => {
      const name = await promptText({
        title: t("fileBrowser.promptNewFolderTitle"),
        initialValue: t("fileBrowser.promptNewFolderDefault"),
      });
      if (!name) return;
      const dir = side === "remote" ? session?.remote.path ?? "/" : session?.local.path ?? "";
      void controller.mkdir(dir, name, side);
    },
    [controller, promptText, session?.local.path, session?.remote.path, t],
  );

  const createFile = useCallback(
    async (side: FsSide) => {
      const name = await promptText({
        title: t("fileBrowser.promptNewFileTitle"),
        initialValue: t("fileBrowser.promptNewFileDefault"),
      });
      if (!name) return;
      const dir = side === "remote" ? session?.remote.path ?? "/" : session?.local.path ?? "";
      void controller.createFile(dir, name, side);
    },
    [controller, promptText, session?.local.path, session?.remote.path, t],
  );

  const localContext = useCallback(
    (entry: FileEntry, _anchor: { x: number; y: number; }, selectedEntries: FileEntry[]): MenuItem[] => {
      const targets = selectedEntries.length > 0 ? selectedEntries : [entry];
      const target = targets[0] ?? entry;
      const multi = targets.length > 1;
      const items: MenuItem[] = [];
      items.push({
        label: effectiveFileType(entry) === "dir"
          ? t("fileBrowser.contextOpenFolder")
          : multi
            ? t("fileBrowser.contextOpenFiles", { count: targets.length })
            : t("fileBrowser.contextOpen"),
        onClick: () => void handleOpenLocal(targets),
      });
      items.push({
        label: multi ? t("fileBrowser.contextUploadCountToRemote", { count: targets.length }) : t("fileBrowser.contextUploadToRemote"),
        testId: multi ? `context-menu-item-upload-${targets.length}-selected-to-remote` : "context-menu-item-upload-to-remote",
        onClick: () => {
          const remoteDir = session?.remote.path ?? "/";
          for (const item of targets) {
            // Use path mapping if available — check if the local file's path matches a mapping
            const mappedRemote = resolveRemoteByMapping(item.path, mappings);
            void controller.upload(item, mappedRemote ?? remoteDir);
          }
        },
      });
      if (!multi) {
        items.push({
          label: t("fileBrowser.contextRename"),
          onClick: () => void renameEntry(target, "local"),
        });
      }
      items.push({
        label: multi ? t("fileBrowser.contextPermissionsCount", { count: targets.length }) : t("fileBrowser.contextPermissions"),
        onClick: () => setChmodPrompt({ entries: targets, side: "local" }),
      });
      items.push({
        label: multi ? t("fileBrowser.contextDeleteCount", { count: targets.length }) : t("fileBrowser.contextDelete"),
        onClick: () => void deleteEntries(targets, "local"),
        danger: true,
      });
      return items;
    },
    [controller, deleteEntries, handleOpenLocal, mappings, renameEntry, session?.remote.path, t],
  );

  const remoteContext = useCallback(
    (entry: FileEntry, _anchor: { x: number; y: number; }, selectedEntries: FileEntry[]): MenuItem[] => {
      const targets = selectedEntries.length > 0 ? selectedEntries : [entry];
      const target = targets[0] ?? entry;
      const multi = targets.length > 1;
      const items: MenuItem[] = [];
      items.push({
        label: multi ? t("fileBrowser.contextDownloadCountToLocal", { count: targets.length }) : t("fileBrowser.contextDownloadToLocal"),
        testId: multi ? `context-menu-item-download-${targets.length}-selected-to-local` : "context-menu-item-download-to-local",
        onClick: () => {
          const localDir = session?.local.path ?? "";
          for (const item of targets) {
            void controller.download(item, localDir, { openAfter: false });
          }
        },
      });
      if (!multi && target.fileType === "file") {
        items.push({
          label: t("fileBrowser.contextDownloadAndOpen"),
          onClick: () => {
            const localDir = session?.local.path ?? "";
            void controller.download(target, localDir, { openAfter: true });
          },
        });
      }
      if (!multi) {
        items.push({
          label: t("fileBrowser.contextRename"),
          onClick: () => void renameEntry(target, "remote"),
        });
      }
      items.push({
        label: multi ? t("fileBrowser.contextPermissionsCount", { count: targets.length }) : t("fileBrowser.contextPermissions"),
        onClick: () => setChmodPrompt({ entries: targets, side: "remote" }),
      });
      items.push({
        label: multi ? t("fileBrowser.contextDeleteCount", { count: targets.length }) : t("fileBrowser.contextDelete"),
        onClick: () => void deleteEntries(targets, "remote"),
        danger: true,
      });
      return items;
    },
    [controller, deleteEntries, renameEntry, session?.local.path, t],
  );

  const localEmptyContext = useCallback(
    (): MenuItem[] => [
      {
        label: t("fileBrowser.contextNewFolder"),
        onClick: () => void createFolder("local"),
      },
      {
        label: t("fileBrowser.contextNewFile"),
        onClick: () => void createFile("local"),
      },
    ],
    [createFile, createFolder, t],
  );

  const remoteEmptyContext = useCallback(
    (): MenuItem[] => [
      {
        label: t("fileBrowser.contextNewFolder"),
        onClick: () => void createFolder("remote"),
      },
      {
        label: t("fileBrowser.contextNewFile"),
        onClick: () => void createFile("remote"),
      },
    ],
    [createFile, createFolder, t],
  );
  const transfers = useFileBrowserTransfers({
    props,
    session,
    controller,
    mappings,
    setStatus,
    t,
    navigate,
  });

  const banner = useMemo(() => {
    if (!session) return null;
    if (session.attaching) return t("fileBrowser.bannerAttaching");
    if (session.error) return t("fileBrowser.bannerError", { error: session.error });
    if (!session.attached) return t("fileBrowser.bannerNotAttached");
    return null;
  }, [session, t]);

  const showCwdToolbar = !!props.onRequestTerminalCwd || props.cwdHint != null;

  return <FileBrowserView
    props={props}
    t={t}
    orientation={orientation}
    setOrientation={setOrientation}
    mappings={mappings}
    showMappings={showMappings}
    setShowMappings={setShowMappings}
    showCwdToolbar={showCwdToolbar}
    terminalSync={terminalSync}
    setMappings={setMappings}
    session={session}
    navigate={navigate}
    banner={banner}
    connection={connection}
    setStatus={setStatus}
    orientationScope={orientationScope}
    handleDoubleClick={handleDoubleClick}
    remoteContext={remoteContext}
    remoteEmptyContext={remoteEmptyContext}
    transfers={transfers}
    remoteFilter={remoteFilter}
    setRemoteFilter={setRemoteFilter}
    controller={controller}
    deleteEntries={deleteEntries}
    setChmodPrompt={setChmodPrompt}
    setPreviewing={setPreviewing}
    createFolder={createFolder}
    createFile={createFile}
    localContext={localContext}
    localEmptyContext={localEmptyContext}
    handleOpenLocal={handleOpenLocal}
    localFilter={localFilter}
    setLocalFilter={setLocalFilter}
    downloadPrompt={downloadPrompt}
    setDownloadPrompt={setDownloadPrompt}
    handleDownloadConfirmed={handleDownloadConfirmed}
    chmodPrompt={chmodPrompt}
    previewing={previewing}
    confirmDialogRender={confirmDialogRender}
    textInputDialogRender={textInputDialogRender}
  />;
}

export { basename } from "../../lib/sftp";

export { type SftpPendingUploadRequest } from "./browser/types";
