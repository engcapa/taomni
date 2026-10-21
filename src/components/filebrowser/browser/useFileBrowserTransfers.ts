import { useCallback, useEffect, useRef } from "react";
import { useT } from "../../../lib/i18n";
import { parentPath, sftpStat, type FileEntry } from "../../../lib/sftp";
import { useSftpController } from "../../../lib/sftpController";
import { useSftpStore, type PaneSide } from "../../../stores/sftpStore";
import type { SftpPathMapping } from "../../../types";
import { resolveLocalByMapping, resolveRemoteByMapping } from "../PathMappingsEditor";
import { type FileBrowserProps } from "./types";

export interface UseFileBrowserTransfersContext {
  props: FileBrowserProps;
  session: import("../../../stores/sftpStore").SftpSessionState;
  controller: ReturnType<typeof useSftpController>;
  mappings: SftpPathMapping[];
  setStatus: (message: string) => void;
  t: ReturnType<typeof useT>;
  navigate: (sessionId: string, side: PaneSide, path: string) => Promise<void>;
}

export function useFileBrowserTransfers(context: UseFileBrowserTransfersContext) {
  const { props, session, controller, mappings, setStatus, t, navigate } = context;
  const handledUploadRequestRef = useRef<number | null>(null);
  const onPendingUploadRequestHandledRef = useRef(props.onPendingUploadRequestHandled);

  useEffect(() => {
    onPendingUploadRequestHandledRef.current = props.onPendingUploadRequestHandled;
  }, [props.onPendingUploadRequestHandled]);

  const handleLocalFiles = useCallback(
    async (files: File[]) => {
      const remoteDir = session?.remote.path ?? "/";
      for (const file of files) {
        await controller.uploadBlob(remoteDir, file);
      }
    },
    [controller, session?.remote.path],
  );

  const handleLocalPaths = useCallback(
    async (paths: string[]) => {
      const remoteDir = session?.remote.path ?? "/";
      for (const path of paths) {
        try {
          const entry = await sftpStat(props.sessionId, path, "local");
          // Use path mapping if available
          const mappedRemote = resolveRemoteByMapping(entry.path, mappings);
          await controller.upload(entry, mappedRemote ?? remoteDir);
        } catch (err) {
          setStatus(t("fileBrowser.statusUploadFailed", { error: err instanceof Error ? err.message : String(err) }));
        }
      }
    },
    [controller, mappings, props.sessionId, session?.remote.path, setStatus, t],
  );

  useEffect(() => {
    const request = props.pendingUploadRequest;
    if (!request) return;
    if (handledUploadRequestRef.current === request.id) return;
    if (!session?.attached) return;

    handledUploadRequestRef.current = request.id;
    let cancelled = false;
    let finished = false;
    const finishRequest = () => {
      if (finished) return;
      finished = true;
      onPendingUploadRequestHandledRef.current?.(request.id);
    };

    void (async () => {
      const currentRemotePath = useSftpStore.getState().sessions[props.sessionId]?.remote.path ?? "/";
      const remoteDir = request.remoteDir || currentRemotePath;
      try {
        if (currentRemotePath !== remoteDir) {
          await navigate(props.sessionId, "remote", remoteDir);
        }
      } catch (err) {
        setStatus(t("fileBrowser.statusNavigateFailed", { error: String(err) }));
      }

      let localDir: string | null = null;
      for (const path of request.paths) {
        if (cancelled) return;
        try {
          const entry = await sftpStat(props.sessionId, path, "local");
          if (!localDir) {
            localDir = parentPath(entry.path);
            if (localDir) {
              await navigate(props.sessionId, "local", localDir);
            }
          }
          await controller.upload(entry, remoteDir);
        } catch (err) {
          setStatus(t("fileBrowser.statusUploadFailed", { error: err instanceof Error ? err.message : String(err) }));
        }
      }

      finishRequest();
    })();

    return () => {
      cancelled = true;
      // The request is one-shot. Closing the sidebar discards paths that have
      // not started yet so remounting cannot enqueue the same batch again.
      finishRequest();
    };
  }, [
    controller.upload,
    navigate,
    props.pendingUploadRequest,
    props.sessionId,
    session?.attached,
    setStatus,
    t,
  ]);

  const handleCrossPaneToLocal = useCallback(
    async (entries: FileEntry[]) => {
      const localDir = session?.local.path ?? "";
      for (const entry of entries) {
        // Use path mapping if available — map remote path back to local
        const mappedLocal = resolveLocalByMapping(entry.path, mappings);
        const targetDir = mappedLocal
          ? (entry.fileType === "dir" ? mappedLocal : mappedLocal.replace(/[/\\][^/\\]*$/, "") || localDir)
          : localDir;
        await controller.download(entry, targetDir, { openAfter: false });
      }
    },
    [controller, mappings, session?.local.path],
  );

  const handleCrossPaneToRemote = useCallback(
    async (entries: FileEntry[]) => {
      const remoteDir = session?.remote.path ?? "/";
      for (const entry of entries) {
        // Use path mapping if available
        const mappedRemote = resolveRemoteByMapping(entry.path, mappings);
        await controller.upload(entry, mappedRemote ?? remoteDir);
      }
    },
    [controller, mappings, session?.remote.path],
  );
  return { handleCrossPaneToRemote, handleLocalFiles, handleLocalPaths, handleCrossPaneToLocal };
}
