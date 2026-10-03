import { useEffect, useState, useCallback } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { FilePanel } from "../filebrowser/FilePanel";
import { FileTransferQueue } from "../filebrowser/FileTransferQueue";
import type { MenuItem } from "../ContextMenu";
import { useObjectStorageStore } from "../../stores/objectStorageStore";
import type { FilePanelStoreHook } from "../../stores/sftpStore";
import { useObjectStorageController, splitRemote } from "../../lib/objectStorageController";
import { storageHeadObject } from "../../lib/objectStorage";
import { presetFor, type ObjectStorageConfig } from "../../types/objectStorage";
import { formatBytes, type FileEntry } from "../../lib/sftp";
import { confirmAppDialog, promptAppDialog, alertAppDialog } from "../../lib/appDialogs";

const storeHook = useObjectStorageStore as unknown as FilePanelStoreHook;

interface ObjectStorageBrowserProps {
  sessionId: string;
  config: ObjectStorageConfig;
  title?: string;
}

export function ObjectStorageBrowser({ sessionId, config, title }: ObjectStorageBrowserProps) {
  const attach = useObjectStorageStore((s) => s.attach);
  const detach = useObjectStorageStore((s) => s.detach);
  const navigate = useObjectStorageStore((s) => s.navigate);
  const session = useObjectStorageStore((s) => s.sessions[sessionId]);
  const ctl = useObjectStorageController(sessionId);
  const [remoteFilter, setRemoteFilter] = useState("");
  const [localFilter, setLocalFilter] = useState("");

  useEffect(() => {
    void attach(sessionId, config).catch(() => {});
    return () => {
      void detach(sessionId);
    };
    // Re-attach only if the session identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const remotePane = session?.remote;
  const localPane = session?.local;
  const providerLabel = presetFor(config.provider).label;

  const showMetadata = useCallback(
    async (entry: FileEntry) => {
      const { bucket, key } = splitRemote(entry.path);
      if (!bucket || !key || entry.fileType === "dir") return;
      try {
        const meta = await storageHeadObject(sessionId, bucket, key);
        const lines = [
          `Key: ${meta.key}`,
          `Size: ${formatBytes(meta.size)} (${meta.size} bytes)`,
          meta.contentType ? `Content-Type: ${meta.contentType}` : null,
          meta.etag ? `ETag: ${meta.etag}` : null,
          meta.lastModified ? `Modified: ${new Date(meta.lastModified * 1000).toLocaleString()}` : null,
          meta.storageClass ? `Storage class: ${meta.storageClass}` : null,
          meta.cacheControl ? `Cache-Control: ${meta.cacheControl}` : null,
          ...Object.entries(meta.userMetadata).map(([k, v]) => `x-meta ${k}: ${v}`),
        ].filter(Boolean);
        await alertAppDialog({ title: entry.name, message: lines.join("\n") });
      } catch (err) {
        await alertAppDialog({ title: "Metadata", message: err instanceof Error ? err.message : String(err) });
      }
    },
    [sessionId],
  );

  const share = useCallback(
    async (entry: FileEntry) => {
      const ttlStr = await promptAppDialog({
        title: "Share link",
        label: "Expiry (seconds)",
        initialValue: "3600",
      });
      if (ttlStr == null) return;
      const ttl = Math.max(1, parseInt(ttlStr, 10) || 3600);
      const url = await ctl.shareUrl(entry, ttl);
      if (url) await alertAppDialog({ title: "Share link (copied)", message: url });
    },
    [ctl],
  );

  const confirmDelete = useCallback(
    async (entries: FileEntry[]) => {
      const isBucket = entries.some((e) => !splitRemote(e.path).key);
      const ok = await confirmAppDialog({
        title: "Delete",
        message: isBucket
          ? `Delete bucket "${entries[0]?.name}" and stop? This cannot be undone.`
          : `Delete ${entries.length} item(s)? Folders are deleted recursively.`,
        danger: true,
        confirmLabel: "Delete",
      });
      if (!ok) return;
      for (const e of entries) await ctl.remove(e);
    },
    [ctl],
  );

  const remoteDir = remotePane?.path ?? "/";
  const localDir = localPane?.path ?? "";

  const onRemoteDoubleClick = useCallback(
    (entry: FileEntry) => {
      if (entry.fileType === "dir") void navigate(sessionId, "remote", entry.path);
      else void ctl.download(entry, localDir);
    },
    [ctl, localDir, navigate, sessionId],
  );

  const onLocalDoubleClick = useCallback(
    (entry: FileEntry) => {
      if (entry.fileType === "dir") void navigate(sessionId, "local", entry.path);
    },
    [navigate, sessionId],
  );

  const remoteItemMenu = useCallback(
    (entry: FileEntry, _anchor: { x: number; y: number }, selected: FileEntry[]): MenuItem[] => {
      const isFile = entry.fileType === "file";
      const { key } = splitRemote(entry.path);
      const items: MenuItem[] = [
        { label: "Download", onClick: () => void selected.forEach((e) => void ctl.download(e, localDir)) },
      ];
      if (isFile) {
        items.push({ label: "Share link…", onClick: () => void share(entry) });
        items.push({ label: "Properties…", onClick: () => void showMetadata(entry) });
      }
      if (key) {
        items.push({ separator: true, label: "" });
        items.push({
          label: "Rename…",
          onClick: async () => {
            const name = await promptAppDialog({ title: "Rename", label: "New name", initialValue: entry.name });
            if (name && name !== entry.name) await ctl.rename(entry, name);
          },
        });
        items.push({
          label: "Copy to…",
          onClick: async () => {
            const dest = await promptAppDialog({
              title: "Copy to",
              label: "Destination prefix (/bucket/prefix/)",
              initialValue: remoteDir,
            });
            if (dest) await ctl.copyTo(entry, dest);
          },
        });
      }
      items.push({ separator: true, label: "" });
      items.push({ label: "Delete", danger: true, onClick: () => void confirmDelete(selected) });
      return items;
    },
    [confirmDelete, ctl, localDir, remoteDir, share, showMetadata],
  );

  const remoteEmptyMenu = useCallback((): MenuItem[] => {
    const atRoot = remoteDir === "/" || !splitRemote(remoteDir).bucket;
    return [
      {
        label: atRoot ? "New bucket…" : "New folder…",
        onClick: async () => {
          const name = await promptAppDialog({ title: atRoot ? "New bucket" : "New folder", label: "Name" });
          if (name) await ctl.mkdir(remoteDir, name);
        },
      },
    ];
  }, [ctl, remoteDir]);

  const localItemMenu = useCallback(
    (_entry: FileEntry, _anchor: { x: number; y: number }, selected: FileEntry[]): MenuItem[] => [
      { label: "Upload to object store", onClick: () => void selected.forEach((e) => void ctl.upload(e, remoteDir)) },
    ],
    [ctl, remoteDir],
  );

  return (
    <div className="h-full w-full flex flex-col min-h-0">
      <div
        className="h-7 flex items-center px-3 text-[11px] border-b shrink-0 gap-2"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
      >
        <span className="font-semibold">{title ?? providerLabel}</span>
        <span style={{ color: "var(--taomni-text-muted)" }}>{providerLabel}</span>
        {session?.error && <span className="text-red-500 truncate">{session.error}</span>}
      </div>
      <div className="flex-1 min-h-0">
        <PanelGroup orientation="horizontal" id={`oss-browser-${sessionId}`}>
          <Panel id="remote" defaultSize="55%" minSize="20%" className="flex flex-col min-h-0 min-w-0">
            <FilePanel
              sessionId={sessionId}
              side="remote"
              store={storeHook}
              subtitle={providerLabel}
              onItemDoubleClick={onRemoteDoubleClick}
              onItemContext={remoteItemMenu}
              onEmptyContext={remoteEmptyMenu}
              filterText={remoteFilter}
              onFilterTextChange={setRemoteFilter}
              acceptCrossPane
              onCrossPaneDrop={(entries) => entries.forEach((e) => void ctl.upload(e, remoteDir))}
              onDownloadSelected={(entries) => entries.forEach((e) => void ctl.download(e, localDir))}
              onUploadPathsFromDisk={(paths) =>
                paths.forEach((p) => {
                  const name = p.split(/[\\/]/).pop() ?? p;
                  const { bucket } = splitRemote(remoteDir);
                  if (bucket) void ctl.upload({ name, path: p, fileType: "file", size: 0, mtime: 0, mode: 0, isHidden: false }, remoteDir);
                })
              }
              onDeleteSelected={(entries) => void confirmDelete(entries)}
              onNewFolder={async () => {
                const atRoot = remoteDir === "/" || !splitRemote(remoteDir).bucket;
                const name = await promptAppDialog({ title: atRoot ? "New bucket" : "New folder", label: "Name" });
                if (name) await ctl.mkdir(remoteDir, name);
              }}
            />
          </Panel>
          <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
          <Panel id="local" defaultSize="45%" minSize="20%" className="flex flex-col min-h-0 min-w-0">
            <FilePanel
              sessionId={sessionId}
              side="local"
              store={storeHook}
              subtitle="local"
              onItemDoubleClick={onLocalDoubleClick}
              onItemContext={localItemMenu}
              filterText={localFilter}
              onFilterTextChange={setLocalFilter}
              acceptCrossPane
              onCrossPaneDrop={(entries) => entries.forEach((e) => void ctl.download(e, localDir))}
              onUploadSelected={(entries) => entries.forEach((e) => void ctl.upload(e, remoteDir))}
            />
          </Panel>
        </PanelGroup>
      </div>
      <FileTransferQueue
        sessionId={sessionId}
        onCancel={ctl.cancelTransfer}
        onPause={ctl.pauseTransfer}
        onResume={ctl.resumeTransfer}
        compact
      />
    </div>
  );
}

