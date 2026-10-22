import { useEffect, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { listenSshAuthPrompt, submitSshAuthResponse, type SshAuthPromptPayload } from "../../../lib/ipc";
import { useSftpStore, type PaneSide } from "../../../stores/sftpStore";
import { type FileBrowserProps } from "./types";

export interface UseFileBrowserConnectionContext {
  props: FileBrowserProps;
  navigate: (sessionId: string, side: PaneSide, path: string) => Promise<void>;
  setStatus: (message: string) => void;
  t: ReturnType<typeof useT>;
}

export function useFileBrowserConnection(context: UseFileBrowserConnectionContext) {
  const { props, navigate, setStatus, t } = context;
  const ensureSession = useSftpStore((s) => s.ensureSession);
  const attach = useSftpStore((s) => s.attach);
  const detach = useSftpStore((s) => s.detach);
  const reconnect = useSftpStore((s) => s.reconnect);
  const [mfaPrompt, setMfaPrompt] = useState<SshAuthPromptPayload | null>(null);
  const pendingMfaRequestIdRef = useRef<string | null>(null);
  const authPromptReadyRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let destroyed = false;
    let unlistenAuthPrompt: (() => void) | null = null;
    const sid = props.sessionId;

    setMfaPrompt(null);
    pendingMfaRequestIdRef.current = null;

    const ready = listenSshAuthPrompt(sid, (payload) => {
      if (destroyed) {
        void submitSshAuthResponse(payload.requestId, null).catch(() => { });
        return;
      }
      pendingMfaRequestIdRef.current = payload.requestId;
      setMfaPrompt(payload);
    })
      .then((unlisten) => {
        if (destroyed) {
          unlisten();
        } else {
          unlistenAuthPrompt = unlisten;
        }
      })
      .catch(() => undefined);

    authPromptReadyRef.current = ready;

    return () => {
      destroyed = true;
      unlistenAuthPrompt?.();
      if (pendingMfaRequestIdRef.current) {
        void submitSshAuthResponse(pendingMfaRequestIdRef.current, null).catch(() => { });
        pendingMfaRequestIdRef.current = null;
      }
    };
  }, [props.sessionId]);

  useEffect(() => {
    let cancelled = false;
    ensureSession(props.sessionId);
    void (async () => {
      await authPromptReadyRef.current.catch(() => undefined);
      if (cancelled) return;
      const current = useSftpStore.getState().sessions[props.sessionId];
      if (current?.attached || current?.attaching) return;
      attach({
        sessionId: props.sessionId,
        host: props.host,
        port: props.port,
        username: props.username,
        authMethod: props.authMethod,
        authData: props.authData,
        networkSettingsJson: props.networkSettingsJson ?? null,
      })
        .then(() => {
          if (!cancelled && props.initialPath) {
            void navigate(props.sessionId, "remote", props.initialPath);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setStatus(t("fileBrowser.statusSftpConnectFailed", { error: String(err) }));
          }
        });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  // Tear down the SFTP channel when this view unmounts. The store
  // ref-counts attaches, so a sidebar + detached window with the same
  // session id are safe. We do not detach the attached sidebar session on
  // unmount so that the session, its navigated folders, and active transfers
  // are preserved when the user merely hides the sidebar.
  useEffect(() => {
    const sid = props.sessionId;
    const isAttachedSidebar = sid.startsWith("attached-") && !sid.endsWith("__detached");
    return () => {
      if (!isAttachedSidebar) {
        void detach(sid);
      }
    };
  }, [props.sessionId, detach]);

  useEffect(() => {
    const handleTerminalReconnected = (e: Event) => {
      const customEvent = e as CustomEvent<{ tabId: string; }>;
      const targetTabId = customEvent.detail?.tabId;
      if (!targetTabId) return;

      const isAttachedSidebar = props.sessionId === `attached-${targetTabId}`;
      if (isAttachedSidebar) {
        void reconnect(props.sessionId).catch((err) => {
          console.error("Auto-reconnection of SFTP failed:", err);
        });
      }
    };

    window.addEventListener("taomni:terminal-reconnected", handleTerminalReconnected);
    return () => {
      window.removeEventListener("taomni:terminal-reconnected", handleTerminalReconnected);
    };
  }, [props.sessionId, reconnect]);
  return { reconnect, mfaPrompt, pendingMfaRequestIdRef, setMfaPrompt };
}
