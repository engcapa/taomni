import { useCallback } from "react";
import {
  joinPath,
  listenSftpComplete,
  listenSftpProgress,
  sftpCancelTransfer,
  sftpDownload,
  sftpMkdir,
  sftpOpenPath,
  sftpRemove,
  sftpRename,
  sftpUpload,
  sftpUploadBytes,
  type FileEntry,
  type FsSide,
} from "./sftp";
import { newTransferId, useTransferStore } from "../stores/transferStore";
import { useSftpStore, type PaneSide } from "../stores/sftpStore";
import { useAppStore } from "../stores/appStore";
import { encodeBase64 } from "./ipc";
import { isTauriRuntime } from "./runtime";

export interface TransferStartOpts {
  openAfter?: boolean;
}

export function useSftpController(sessionId: string) {
  const refreshPane = useSftpStore((s) => s.refreshPane);
  const setStatus = useAppStore((s) => s.setStatusMessage);
  const addTransfer = useTransferStore((s) => s.add);
  const patchTransfer = useTransferStore((s) => s.patch);
  const setTransferState = useTransferStore((s) => s.setState);

  const startTransferTracking = useCallback(
    (transferId: string, refreshSide: PaneSide) => {
      let unlistenProgress: (() => void) | null = null;
      let unlistenComplete: (() => void) | null = null;

      void listenSftpProgress(transferId, (payload) => {
        patchTransfer(transferId, {
          bytes: payload.bytes,
          size: payload.total || undefined,
          rate: payload.rate,
          eta: payload.eta,
          state: "running",
        });
      }).then((u) => {
        unlistenProgress = u;
      });

      void listenSftpComplete(transferId, (payload) => {
        if (payload.success) {
          setTransferState(transferId, "done");
          setStatus(`Transfer complete: ${transferId}`);
          void refreshPane(sessionId, refreshSide);
        } else {
          const isCancel = (payload.error || "").toLowerCase().includes("cancel");
          setTransferState(
            transferId,
            isCancel ? "cancelled" : "error",
            payload.error ?? "transfer failed",
          );
        }
        unlistenProgress?.();
        unlistenComplete?.();
      }).then((u) => {
        unlistenComplete = u;
      });
    },
    [patchTransfer, refreshPane, sessionId, setStatus, setTransferState],
  );

  const upload = useCallback(
    async (
      entry: FileEntry,
      remoteDir: string,
      opts: TransferStartOpts = {},
    ) => {
      if (entry.fileType === "dir") {
        setStatus("Folder upload is not supported in this MVP.");
        return;
      }
      const transferId = newTransferId();
      const remotePath = joinPath(remoteDir, entry.name);
      addTransfer({
        id: transferId,
        sessionId,
        direction: "upload",
        localPath: entry.path,
        remotePath,
        size: entry.size,
        bytes: 0,
        rate: 0,
        eta: 0,
        state: "queued",
        startedAt: Date.now(),
        openAfter: opts.openAfter,
      });
      startTransferTracking(transferId, "remote");
      try {
        await sftpUpload(sessionId, transferId, entry.path, remotePath, !!opts.openAfter);
      } catch (err) {
        setStatus(`Upload failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [addTransfer, sessionId, setStatus, startTransferTracking],
  );

  const uploadBlob = useCallback(
    async (
      remoteDir: string,
      file: File,
    ) => {
      const transferId = newTransferId();
      const remotePath = joinPath(remoteDir, file.name);
      addTransfer({
        id: transferId,
        sessionId,
        direction: "upload",
        localPath: `OS:${file.name}`,
        remotePath,
        size: file.size,
        bytes: 0,
        rate: 0,
        eta: 0,
        state: "queued",
        startedAt: Date.now(),
      });
      startTransferTracking(transferId, "remote");
      try {
        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(
            null,
            Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
          );
        }
        const b64 = btoa(binary);
        await sftpUploadBytes(sessionId, transferId, file.name, remotePath, b64);
      } catch (err) {
        setStatus(`Upload failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [addTransfer, sessionId, setStatus, startTransferTracking],
  );

  const download = useCallback(
    async (
      entry: FileEntry,
      localDir: string,
      opts: TransferStartOpts = {},
    ) => {
      if (entry.fileType === "dir") {
        setStatus("Folder download is not supported in this MVP.");
        return;
      }
      const transferId = newTransferId();
      const localPath = joinPath(localDir, entry.name);
      addTransfer({
        id: transferId,
        sessionId,
        direction: "download",
        localPath,
        remotePath: entry.path,
        size: entry.size,
        bytes: 0,
        rate: 0,
        eta: 0,
        state: "queued",
        startedAt: Date.now(),
        openAfter: opts.openAfter,
      });
      startTransferTracking(transferId, "local");
      try {
        await sftpDownload(sessionId, transferId, entry.path, localPath, !!opts.openAfter);
        if (opts.openAfter && isTauriRuntime()) {
          try {
            await sftpOpenPath(localPath);
          } catch (err) {
            setStatus(`Saved to ${localPath}, but could not open it: ${err}`);
          }
        }
      } catch (err) {
        setStatus(`Download failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [addTransfer, sessionId, setStatus, startTransferTracking],
  );

  const mkdir = useCallback(
    async (parent: string, name: string, side: FsSide) => {
      const target = joinPath(parent, name);
      try {
        await sftpMkdir(sessionId, target, side);
        await refreshPane(sessionId, side);
      } catch (err) {
        setStatus(`mkdir failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, sessionId, setStatus],
  );

  const remove = useCallback(
    async (path: string, side: FsSide, recursive = true) => {
      try {
        await sftpRemove(sessionId, path, side, recursive);
        await refreshPane(sessionId, side);
      } catch (err) {
        setStatus(`Delete failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, sessionId, setStatus],
  );

  const rename = useCallback(
    async (oldPath: string, newName: string, side: FsSide) => {
      const parent = oldPath.includes("/")
        ? oldPath.slice(0, oldPath.lastIndexOf("/")) || "/"
        : "";
      const newPath = joinPath(parent, newName);
      try {
        await sftpRename(sessionId, oldPath, newPath, side);
        await refreshPane(sessionId, side);
      } catch (err) {
        setStatus(`Rename failed: ${err instanceof Error ? err.message : err}`);
      }
    },
    [refreshPane, sessionId, setStatus],
  );

  const cancelTransfer = useCallback(async (transferId: string) => {
    try {
      await sftpCancelTransfer(transferId);
      setTransferState(transferId, "cancelled");
    } catch (err) {
      setStatus(`Cancel failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [setStatus, setTransferState]);

  const encodedAuth = useCallback((value: string | null): string | null => {
    if (value == null) return null;
    return encodeBase64(value);
  }, []);

  return {
    upload,
    uploadBlob,
    download,
    mkdir,
    remove,
    rename,
    cancelTransfer,
    encodedAuth,
  };
}
