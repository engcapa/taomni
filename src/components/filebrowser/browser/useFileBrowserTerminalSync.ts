import { useCallback, useEffect, useRef } from "react";
import { useT } from "../../../lib/i18n";
import { type PaneSide } from "../../../stores/sftpStore";
import { remotePathForTerminalCwd } from "./preferences";
import { type FileBrowserProps } from "./types";

export interface UseFileBrowserTerminalSyncContext {
  props: FileBrowserProps;
  setStatus: (message: string) => void;
  t: ReturnType<typeof useT>;
  session: import("../../../stores/sftpStore").SftpSessionState;
  navigate: (sessionId: string, side: PaneSide, path: string) => Promise<void>;
}

export function useFileBrowserTerminalSync(context: UseFileBrowserTerminalSyncContext) {
  const { props, setStatus, t, session, navigate } = context;

  const pendingTerminalSyncRef = useRef(false);
  const requestedCwdVersionRef = useRef(props.cwdHintVersion ?? 0);
  const terminalSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTerminalSyncTimeout = useCallback(() => {
    if (!terminalSyncTimeoutRef.current) return;
    clearTimeout(terminalSyncTimeoutRef.current);
    terminalSyncTimeoutRef.current = null;
  }, []);

  useEffect(() => {
    pendingTerminalSyncRef.current = false;
    requestedCwdVersionRef.current = props.cwdHintVersion ?? 0;
    clearTerminalSyncTimeout();
  }, [clearTerminalSyncTimeout, props.sessionId]);

  useEffect(() => () => clearTerminalSyncTimeout(), [clearTerminalSyncTimeout]);

  const syncToTerminalCwd = useCallback(() => {
    if (props.onRequestTerminalCwd) {
      pendingTerminalSyncRef.current = true;
      requestedCwdVersionRef.current = props.cwdHintVersion ?? 0;
      clearTerminalSyncTimeout();
      const requested = props.onRequestTerminalCwd();
      if (!requested) {
        pendingTerminalSyncRef.current = false;
        return;
      }
      terminalSyncTimeoutRef.current = setTimeout(() => {
        if (!pendingTerminalSyncRef.current) return;
        pendingTerminalSyncRef.current = false;
        terminalSyncTimeoutRef.current = null;
        setStatus(t("fileBrowser.statusTerminalCwdSilent"));
      }, 5000);
      setStatus(t("fileBrowser.statusRequestingTerminalCwd"));
      return;
    }
    if (!props.cwdHint) {
      setStatus(t("fileBrowser.statusTerminalCwdUnknown"));
      return;
    }
    if (!session?.attached) return;
    const remoteCwd = remotePathForTerminalCwd(props.cwdHint, session.homeDir);
    if (session.remote.path === remoteCwd) {
      setStatus(t("fileBrowser.statusAlreadyAt", { path: remoteCwd }));
      return;
    }
    void navigate(props.sessionId, "remote", remoteCwd);
  }, [
    clearTerminalSyncTimeout,
    navigate,
    props.cwdHint,
    props.cwdHintVersion,
    props.onRequestTerminalCwd,
    props.sessionId,
    session?.attached,
    session?.homeDir,
    session?.remote.path,
    setStatus,
  ]);

  useEffect(() => {
    if (!pendingTerminalSyncRef.current) return;
    if (!session?.attached) return;
    if (!props.cwdHint) return;
    const version = props.cwdHintVersion ?? 0;
    if (version <= requestedCwdVersionRef.current) return;

    pendingTerminalSyncRef.current = false;
    clearTerminalSyncTimeout();
    const remoteCwd = remotePathForTerminalCwd(props.cwdHint, session.homeDir);
    if (session.remote.path === remoteCwd) {
      setStatus(t("fileBrowser.statusAlreadyAt", { path: remoteCwd }));
      return;
    }
    void navigate(props.sessionId, "remote", remoteCwd);
  }, [
    clearTerminalSyncTimeout,
    navigate,
    props.cwdHint,
    props.cwdHintVersion,
    props.sessionId,
    session?.attached,
    session?.homeDir,
    session?.remote.path,
    setStatus,
  ]);
  return { syncToTerminalCwd };
}
