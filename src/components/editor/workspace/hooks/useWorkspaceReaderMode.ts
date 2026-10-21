import { useCallback, useEffect, useState } from "react";
import { readHighlightingLevel, writeHighlightingLevel, type HighlightingLevel } from "../highlightingLevelModel";
import { isDocCommentRenderingSupported, readReaderModePreference, writeReaderModePreference } from "../renderedDocCommentsModel";


export interface UseWorkspaceReaderModeContext {
  workspaceInstanceId: string;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  activeRenderedDocLanguageId: string | null;
  setStatusMessage: (message: string) => void;
}

export function useWorkspaceReaderMode(context: UseWorkspaceReaderModeContext) {
  const { workspaceInstanceId, activeFile, activeRenderedDocLanguageId, setStatusMessage } = context;
  const [dismissedBannerKeys, setDismissedBannerKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    setDismissedBannerKeys(new Set());
  }, [workspaceInstanceId]);
  const [fileHighlightingLevels, setFileHighlightingLevels] = useState<Record<string, HighlightingLevel>>({});

  const getFileHighlightingLevel = useCallback((fileKey: string): HighlightingLevel => {
    return fileHighlightingLevels[fileKey] ?? readHighlightingLevel(workspaceInstanceId, fileKey);
  }, [fileHighlightingLevels, workspaceInstanceId]);

  const setFileHighlightingLevel = useCallback((fileKey: string, level: HighlightingLevel) => {
    writeHighlightingLevel(workspaceInstanceId, fileKey, level);
    setFileHighlightingLevels((prev) => ({ ...prev, [fileKey]: level }));
  }, [workspaceInstanceId]);
  const [readerModeByFile, setReaderModeByFile] = useState<Record<string, boolean>>({});

  const setRenderedDocMode = useCallback((fileKey: string, enabled: boolean) => {
    writeReaderModePreference(workspaceInstanceId, fileKey, enabled);
    setReaderModeByFile((prev) => {
      if (prev[fileKey] === enabled) return prev;
      return { ...prev, [fileKey]: enabled };
    });
  }, [workspaceInstanceId]);

  const toggleRenderedDocComments = useCallback(() => {
    const file = activeFile;
    if (!file) return;
    if (!isDocCommentRenderingSupported(activeRenderedDocLanguageId)) {
      setStatusMessage(`Rendered documentation comments not supported for ${activeRenderedDocLanguageId || "plain text"}`);
      return;
    }
    const current = readerModeByFile[file.key] ?? readReaderModePreference(workspaceInstanceId, file.key);
    const next = !current;
    setRenderedDocMode(file.key, next);
    setStatusMessage(next ? "Rendered documentation enabled (Reader Mode)" : "Rendered documentation disabled");
  }, [activeFile, activeRenderedDocLanguageId, readerModeByFile, setRenderedDocMode, setStatusMessage, workspaceInstanceId]);

  const revealRenderedDocSource = useCallback((fileKey: string) => {
    setRenderedDocMode(fileKey, false);
    if (fileKey === activeFile?.key) setStatusMessage("Rendered documentation disabled");
  }, [activeFile?.key, setRenderedDocMode, setStatusMessage]);
  return {
    toggleRenderedDocComments,
    revealRenderedDocSource,
    readerModeByFile,
    getFileHighlightingLevel,
    dismissedBannerKeys,
    setDismissedBannerKeys,
    setFileHighlightingLevel,
  };
}
