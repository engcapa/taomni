import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { loadCodeViewProfile, subscribeCodeViewProfile } from "../../../../lib/codeViewProfile";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { useAppStore } from "../../../../stores/appStore";
import { clampCodeWorkspaceFontSize, clampCodeWorkspaceTreeFontSize, readCodeWorkspaceTreeFontSize, writeCodeWorkspaceTreeFontSize } from "../codeWorkspaceModel";
import {
  matchesSoftWrapPath,
  normalizeEditorAppearanceProfile,
  readEditorAppearanceProfileWithDiagnostics,
  writeEditorAppearanceProfile,
  type EditorAppearanceProfile,
} from "../editorAppearanceProfile";


export interface UseWorkspaceAppearanceContext {
  workspaceInstanceId: string;
  clipboardHandle: import("../workspaceClipboardSession").WorkspaceClipboardHandle;
  setStatusMessage: (message: string) => void;
  activeEditorGroupIdRef: import("react").RefObject<string>;
  activeEditorGroupId: string;
  activeKey: string | null;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
}

export function useWorkspaceAppearance(context: UseWorkspaceAppearanceContext) {
  const { activeEditorGroupIdRef, workspaceInstanceId, clipboardHandle, setStatusMessage, activeEditorGroupId, activeKey, openFilesRef } = context;

  const initialEditorAppearance = readEditorAppearanceProfileWithDiagnostics(
    workspaceInstanceId,
    loadCodeViewProfile(),
  );
  const [editorAppearanceProfile, setEditorAppearanceProfileState] = useState<EditorAppearanceProfile>(
    () => {
      if (initialEditorAppearance.source === "migrated") {
        return writeEditorAppearanceProfile(workspaceInstanceId, initialEditorAppearance.profile);
      }
      return initialEditorAppearance.profile;
    },
  );
  const [activeEditorFontSizes, setActiveEditorFontSizes] = useState<Record<EditorGroupId, number>>({});
  const [editorAppearanceSettingsOpen, setEditorAppearanceSettingsOpen] = useState(false);
  const [columnSelectionMode, setColumnSelectionMode] = useState(false);
  const [treeFontSize, setTreeFontSizeState] = useState(() => readCodeWorkspaceTreeFontSize());
  const uiFontSize = useAppStore((state) => state.uiFontSize);
  const effectiveTreeFontSize = Math.max(10, treeFontSize + uiFontSize - 12);
  const editorAppearanceProfileRef = useRef(editorAppearanceProfile);
  const treeFontSizeRef = useRef(treeFontSize);
  const treePaneStyle = useMemo(() => ({
    "--taomni-code-tree-font-size": `${effectiveTreeFontSize}px`,
    "--taomni-code-tree-small-font-size": `${Math.max(10, effectiveTreeFontSize - 1)}px`,
    "--taomni-code-tree-row-height": `${Math.max(24, effectiveTreeFontSize + 15)}px`,
  }) as CSSProperties, [effectiveTreeFontSize]);
  const editorPaneStyle = useMemo(() => ({
    "--taomni-code-editor-ui-font-size": `${editorAppearanceProfile.fontSizePx}px`,
    "--taomni-code-editor-ui-small-font-size": `${Math.max(10, editorAppearanceProfile.fontSizePx - 2)}px`,
    "--taomni-code-editor-tab-height": `${Math.max(28, editorAppearanceProfile.fontSizePx + 15)}px`,
  }) as CSSProperties, [editorAppearanceProfile.fontSizePx]);

  useEffect(() => {
    editorAppearanceProfileRef.current = editorAppearanceProfile;
    clipboardHandle.setHistoryEnabled(editorAppearanceProfile.clipboard.historyEnabled);
    clipboardHandle.setHistoryLimits(
      editorAppearanceProfile.clipboard.historyMaxItems,
      editorAppearanceProfile.clipboard.historyMaxTotalBytes,
    );
  }, [editorAppearanceProfile, clipboardHandle]);

  useEffect(() => {
    const result = readEditorAppearanceProfileWithDiagnostics(
      workspaceInstanceId,
      loadCodeViewProfile(),
    );
    const next = result.source === "migrated"
      ? writeEditorAppearanceProfile(workspaceInstanceId, result.profile)
      : result.profile;
    editorAppearanceProfileRef.current = next;
    setEditorAppearanceProfileState(next);
    setActiveEditorFontSizes({});
    if (result.diagnostic?.kind === "corrupt") {
      setStatusMessage(result.diagnostic.message);
    }
  }, [setStatusMessage, workspaceInstanceId]);

  useEffect(() => {
    treeFontSizeRef.current = treeFontSize;
  }, [treeFontSize]);

  const updateEditorAppearanceProfile = useCallback((
    updater: EditorAppearanceProfile
      | ((current: EditorAppearanceProfile) => EditorAppearanceProfile),
    statusMessage?: (profile: EditorAppearanceProfile) => string,
  ) => {
    const current = editorAppearanceProfileRef.current;
    const next = normalizeEditorAppearanceProfile(
      typeof updater === "function" ? updater(current) : updater,
    );
    editorAppearanceProfileRef.current = next;
    setEditorAppearanceProfileState(next);
    writeEditorAppearanceProfile(workspaceInstanceId, next);
    if (next.zoomScope === "all-editors") setActiveEditorFontSizes({});
    if (statusMessage) setStatusMessage(statusMessage(next));
  }, [setStatusMessage, workspaceInstanceId]);

  useEffect(() => subscribeCodeViewProfile((profile) => {
    updateEditorAppearanceProfile((current) => ({
      ...current,
      fontFamily: profile.fontFamily,
      fontSizePx: profile.fontSize,
      ligatures: profile.fontLigatures,
      // Global code colours are already resolved to inherited CSS variables.
      colorSchemeId: "app",
    }));
  }), [updateEditorAppearanceProfile]);

  const effectiveEditorFontSize = useCallback((groupId: EditorGroupId) => (
    editorAppearanceProfileRef.current.zoomScope === "active-editor"
      ? activeEditorFontSizes[groupId] ?? editorAppearanceProfileRef.current.fontSizePx
      : editorAppearanceProfileRef.current.fontSizePx
  ), [activeEditorFontSizes]);

  const setCodeViewFontSize = useCallback((size: number) => {
    const nextSize = clampCodeWorkspaceFontSize(size);
    if (editorAppearanceProfileRef.current.zoomScope === "active-editor") {
      setActiveEditorFontSizes((current) => ({
        ...current,
        [activeEditorGroupIdRef.current]: nextSize,
      }));
      setStatusMessage(`Active editor zoom ${nextSize}px`);
      return;
    }
    updateEditorAppearanceProfile(
      (current) => ({ ...current, fontSizePx: nextSize }),
      (next) => `Code workspace zoom ${next.fontSizePx}px`,
    );
  }, [setStatusMessage, updateEditorAppearanceProfile]);

  const currentEditorFontSize = effectiveEditorFontSize(activeEditorGroupId);
  const activeAppearancePath = activeKey
    ? openFilesRef.current[activeKey]?.languagePath
    : undefined;
  const activeFileSoftWrap = !!activeAppearancePath && matchesSoftWrapPath(
    activeAppearancePath,
    editorAppearanceProfile.softWrap.patterns,
  );

  const toggleSoftWrap = useCallback(() => {
    const path = activeKey ? openFilesRef.current[activeKey]?.languagePath : undefined;
    if (!path) return;
    updateEditorAppearanceProfile((current) => {
      const enabled = matchesSoftWrapPath(path, current.softWrap.patterns);
      return {
        ...current,
        softWrap: {
          ...current.softWrap,
          patterns: enabled
            ? current.softWrap.patterns.filter((pattern) => !matchesSoftWrapPath(path, [pattern]))
            : [...current.softWrap.patterns, path],
        },
      };
    }, (next) => (
      matchesSoftWrapPath(path, next.softWrap.patterns)
        ? `Soft wrap enabled for ${path}`
        : `Soft wrap disabled for ${path}`
    ));
  }, [activeKey, updateEditorAppearanceProfile]);

  const toggleColumnSelectionMode = useCallback(() => {
    setColumnSelectionMode((current) => {
      const next = !current;
      setStatusMessage(`Column selection mode ${next ? "enabled" : "disabled"}`);
      return next;
    });
  }, [setStatusMessage]);

  const stepCodeViewFontSize = useCallback((delta: number) => {
    setCodeViewFontSize(effectiveEditorFontSize(activeEditorGroupIdRef.current) + delta);
  }, [effectiveEditorFontSize, setCodeViewFontSize]);

  const setTreeFontSize = useCallback(
    (size: number) => {
      const next = clampCodeWorkspaceTreeFontSize(size);
      treeFontSizeRef.current = next;
      setTreeFontSizeState(next);
      writeCodeWorkspaceTreeFontSize(next);
      setStatusMessage(`File tree zoom ${next}px`);
    },
    [setStatusMessage],
  );

  const stepTreeFontSize = useCallback(
    (delta: number) => {
      setTreeFontSize(treeFontSizeRef.current + delta);
    },
    [setTreeFontSize],
  );
  return { stepTreeFontSize, setTreeFontSize, stepCodeViewFontSize, setCodeViewFontSize, currentEditorFontSize, setEditorAppearanceSettingsOpen, activeFileSoftWrap, toggleSoftWrap, columnSelectionMode, toggleColumnSelectionMode, editorAppearanceProfile, activeEditorFontSizes, editorPaneStyle, treePaneStyle, treeFontSize: effectiveTreeFontSize, editorAppearanceSettingsOpen, updateEditorAppearanceProfile };
}
