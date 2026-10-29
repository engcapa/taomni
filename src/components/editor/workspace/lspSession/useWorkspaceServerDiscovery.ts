import { useCallback, useEffect, useRef, useState } from "react";
import {
  lspDetectServers,
  lspSetJavaBundles,
  lspSetJavaHome,
  lspSetJavaSettings,
  lspSetJavaVmargs,
  type LspServerStatus,
} from "../../../../lib/editor/lsp";
import {
  errorMessage,
  readLspJavaHome,
  readLspJavaSettings,
  readLspJavaVmargs,
} from "../codeWorkspaceModel";
import { resolveJavaBundles } from "./java";
import { scheduleAfterEditorPaint } from "../scheduleAfterEditorPaint";

/** Background capability discovery has no ownership of document sync queues. */
export function useWorkspaceServerDiscovery({ visible, autoDiscover, onError, isEditorReady }: {
  visible: boolean;
  autoDiscover: boolean;
  onError: (message: string) => void;
  isEditorReady?: () => boolean;
}) {
  const [serverStatuses, setServerStatuses] = useState<LspServerStatus[]>([]);
  const mountedRef = useRef(true);
  const visibleRef = useRef(visible);
  const demandRef = useRef(autoDiscover);
  const sequenceRef = useRef(0);
  const previousVisibleRef = useRef(visible);
  visibleRef.current = visible;
  demandRef.current = autoDiscover;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sequenceRef.current += 1;
    };
  }, []);

  const refreshServerStatuses = useCallback(async (forceRefresh = false) => {
    const sequence = ++sequenceRef.current;
    const isCurrent = () => mountedRef.current && visibleRef.current && sequenceRef.current === sequence;
    if (!isCurrent()) return;
    try {
      const home = readLspJavaHome().trim();
      await lspSetJavaHome(home || null);
      if (!isCurrent()) return;
      await lspSetJavaVmargs(readLspJavaVmargs());
      if (!isCurrent()) return;
      await lspSetJavaSettings(readLspJavaSettings());
      if (!isCurrent()) return;
      const javaBundles = await resolveJavaBundles();
      if (!isCurrent()) return;
      await lspSetJavaBundles(javaBundles);
      if (!isCurrent()) return;
      const statuses = await lspDetectServers({ javaHome: home || null, forceRefresh });
      if (isCurrent()) setServerStatuses(Array.isArray(statuses) ? statuses : []);
    } catch (error) {
      if (isCurrent()) onError(errorMessage(error));
    }
  }, [onError]);

  const refreshAutomaticServerStatuses = useCallback(async (forceRefresh = false) => {
    if (demandRef.current) await refreshServerStatuses(forceRefresh);
  }, [refreshServerStatuses]);

  useEffect(() => {
    const becameVisible = !previousVisibleRef.current;
    previousVisibleRef.current = visible;
    sequenceRef.current += 1;
    const cancel = visible && autoDiscover
      ? scheduleAfterEditorPaint(() => { void refreshServerStatuses(becameVisible); }, isEditorReady)
      : undefined;
    return () => { cancel?.(); sequenceRef.current += 1; };
  }, [autoDiscover, refreshServerStatuses, visible, isEditorReady]);

  return { serverStatuses, refreshServerStatuses, refreshAutomaticServerStatuses };
}
