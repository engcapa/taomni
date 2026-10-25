import { useCallback, useEffect, useMemo, useRef } from "react";
import { openSettingsSection } from "../../../../lib/settingsNavigation";
import { useCodeWorkspaceStatusStore } from "../../../../stores/codeWorkspaceStatusStore";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { symbolChainAtPosition } from "../Breadcrumbs";
import { resolveEffectiveCodeStyle, type ExplicitIndentationOverride } from "../codeStyleModel";
import { type LspFileState } from "../codeWorkspaceModel";
import { type CodeWorkspaceGitManagerPayload } from "../controller/model";
import { useWorkspaceGitSnapshots } from "../useWorkspaceGitSnapshots";
import { useWorkspaceLspClientEvents } from "../useWorkspaceLspClientEvents";
import { workspaceNavigationSegments } from "../workspaceNavigationBar";
import { useWorkspaceAppearance } from "./useWorkspaceAppearance";
import { useWorkspaceCodeStyle } from "./useWorkspaceCodeStyle";
import { useWorkspaceEditorTelemetry } from "./useWorkspaceEditorTelemetry";
import { useWorkspaceEncoding } from "./useWorkspaceEncoding";


export interface UseWorkspaceStatusBridgeContext {
  lspClientEvents: ReturnType<typeof useWorkspaceLspClientEvents>;
  codeStyle: ReturnType<typeof useWorkspaceCodeStyle>;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  activeKey: string | null;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  setStatusMessage: (message: string) => void;
  visible: boolean;
  tabId: string;
  telemetry: ReturnType<typeof useWorkspaceEditorTelemetry>;
  activeEditorGroupId: string;
  activeLspState: LspFileState | null;
  activeGitRoot: import("../../../../lib/editor/workspace").WorkspaceGitRoot | null;
  gitSnapshotOwner: ReturnType<typeof useWorkspaceGitSnapshots>;
  activeLanguageId: string | null;
  appearance: ReturnType<typeof useWorkspaceAppearance>;
  activeFileIsLarge: boolean;
  roots: CodeWorkspaceRootInfo[];
  gitManagerPayload: CodeWorkspaceGitManagerPayload;
  onOpenGitManager: ((payload: CodeWorkspaceGitManagerPayload) => void) | undefined;
  openGitManager: () => void;
  encoding: ReturnType<typeof useWorkspaceEncoding>;
}

export function useWorkspaceStatusBridge(context: UseWorkspaceStatusBridgeContext) {
  const {
    lspClientEvents,
    codeStyle,
    activeFile,
    activeKey,
    openFilesRef,
    setStatusMessage,
    visible,
    tabId,
    telemetry,
    activeEditorGroupId,
    activeLspState,
    activeGitRoot,
    gitSnapshotOwner,
    activeLanguageId,
    appearance,
    activeFileIsLarge,
    roots,
    gitManagerPayload,
    onOpenGitManager,
    openGitManager,
    encoding,
  } = context;
  const setWorkspaceStatusSegments = useCodeWorkspaceStatusStore((s) => s.setStatus);
  const setWorkspaceStatusActions = useCodeWorkspaceStatusStore((s) => s.setActions);
  const clearWorkspaceStatus = useCodeWorkspaceStatusStore((s) => s.clearForTab);

  const activeLspProgress = lspClientEvents.progresses.length > 0
    ? lspClientEvents.progresses[lspClientEvents.progresses.length - 1]!
    : null;
  const activeLspProgressKey = activeLspProgress
    ? `${activeLspProgress.presetId}\u0000${activeLspProgress.rootUri}\u0000${typeof activeLspProgress.token}:${String(activeLspProgress.token)}`
    : null;

  const activeCodeStyle = useMemo(() => codeStyle.getEffectiveCodeStyleForFile(activeFile), [codeStyle.getEffectiveCodeStyleForFile, activeFile]);
  const activeIndentation = activeCodeStyle?.label ?? "Spaces: 2";

  const cycleActiveFileIndentation = useCallback(() => {
    const key = activeKey;
    const file = key ? openFilesRef.current[key] : null;
    if (!key || !file || file.library) return;
    const currentStyle = resolveEffectiveCodeStyle({
      filePath: file.languagePath,
      text: file.text,
      explicitOverride: codeStyle.indentationOverridesRef.current[key],
    });
    let nextOverride: ExplicitIndentationOverride | null = null;
    if (currentStyle.insertSpaces && currentStyle.indentSize === 2) {
      nextOverride = { type: "spaces", size: 4 };
    } else if (currentStyle.insertSpaces && currentStyle.indentSize === 4) {
      nextOverride = { type: "spaces", size: 8 };
    } else if (currentStyle.insertSpaces && currentStyle.indentSize === 8) {
      nextOverride = { type: "tabs", size: 4 };
    } else if (!currentStyle.insertSpaces && currentStyle.tabSize === 4) {
      nextOverride = { type: "tabs", size: 2 };
    } else if (!currentStyle.insertSpaces && currentStyle.tabSize === 2) {
      nextOverride = null; // reset to auto/default
    } else {
      nextOverride = { type: "spaces", size: 2 };
    }
    codeStyle.setIndentationOverrides((curr) => ({ ...curr, [key]: nextOverride }));
    const nextStyle = resolveEffectiveCodeStyle({
      filePath: file.languagePath,
      text: file.text,
      explicitOverride: nextOverride,
    });
    setStatusMessage(`${file.subtitle}: code style set to ${nextStyle.label}`);
  }, [activeKey, setStatusMessage]);

  useEffect(() => {
    if (!visible) {
      clearWorkspaceStatus(tabId);
      return;
    }
    const cursor = telemetry.cursorPositions[activeEditorGroupId] ?? { line: 0, character: 0 };
    const status = activeLspState?.status ?? null;
    const gitSnapshot = activeGitRoot ? gitSnapshotOwner.gitSnapshots[activeGitRoot.repoRoot] : null;
    setWorkspaceStatusSegments({
      tabId,
      line: cursor.line + 1,
      column: cursor.character + 1,
      encoding: activeFile
        ? `${activeFile.encoding ?? "UTF-8"}${activeFile.bom ? " BOM" : ""}`
        : "UTF-8",
      eol: activeFile?.eol ?? "LF",
      indentation: activeIndentation,
      languageId: status?.languageId ?? activeLanguageId,
      lspActive: !!status?.active,
      lspLabel: status?.displayName ?? (status?.active ? "LSP" : null),
      lspError: !!activeLspState?.error || (!!status && !status.active && !!status.error),
      lspProgress: activeLspProgress
        ? {
          key: activeLspProgressKey ?? "lsp-progress",
          label: activeLspProgress.title ?? activeLspProgress.serverLabel,
          message: activeLspProgress.message,
          percentage: activeLspProgress.percentage,
          cancellable: activeLspProgress.cancellable,
        }
        : null,
      gitBranch: gitSnapshot?.currentBranch ?? null,
      gitAhead: gitSnapshot?.ahead ?? 0,
      gitBehind: gitSnapshot?.behind ?? 0,
      fontSize: appearance.currentEditorFontSize,
      largeFile: activeFileIsLarge,
      // ED-PARITY-010 DEC-010-06: IDEA status bar selection count, lock and
      // navigation bar (root › dirs › file › enclosing symbols).
      selectionChars: telemetry.activeSelectionStats.chars,
      selectionLineBreaks: telemetry.activeSelectionStats.lineBreaks,
      readOnly: !!activeFile?.library,
      navigation: activeFile ? workspaceNavigationSegments(
        activeFile.ref,
        roots,
        symbolChainAtPosition(telemetry.breadcrumbSymbolsByGroup[activeEditorGroupId] ?? [], cursor),
      ) : [],
    });
  }, [
    telemetry.activeSelectionStats,
    telemetry.breadcrumbSymbolsByGroup,
    roots,
    activeEditorGroupId,
    activeKey,
    activeFile?.bom,
    activeFile?.encoding,
    activeFile?.eol,
    activeFileIsLarge,
    activeGitRoot,
    activeIndentation,
    activeLanguageId,
    activeLspState,
    activeLspProgress,
    activeLspProgressKey,
    clearWorkspaceStatus,
    appearance.currentEditorFontSize,
    telemetry.cursorPositions,
    gitSnapshotOwner.gitSnapshots,
    setWorkspaceStatusSegments,
    tabId,
    visible,
  ]);

  const activeLspPresetIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeLspPresetIdRef.current = activeLspState?.status?.presetId ?? null;
  }, [activeLspState?.status?.presetId]);

  const openLanguageServersSettings = useCallback((presetId?: string | null) => {
    openSettingsSection("language-servers", { presetId: presetId ?? null });
  }, []);

  useEffect(() => {
    if (!visible) return;
    setWorkspaceStatusActions(tabId, {
      // Language server install / binary selection lives in Settings (global).
      openLanguagePanel: () => openLanguageServersSettings(activeLspPresetIdRef.current),
      openGitManager: gitManagerPayload.roots.length > 0 && onOpenGitManager ? openGitManager : undefined,
      cycleEol: activeFile && !activeFile.library ? encoding.cycleActiveFileEol : undefined,
      toggleBom: activeFile && !activeFile.library ? encoding.toggleActiveFileBom : undefined,
      chooseEncoding: activeFile && !activeFile.library ? encoding.openFileEncodingDialog : undefined,
      cycleIndentation: activeFile && !activeFile.library ? cycleActiveFileIndentation : undefined,
      cancelLspProgress: activeLspProgress?.cancellable
        ? () => lspClientEvents.cancelProgress(activeLspProgress)
        : undefined,
    });
  }, [
    gitManagerPayload,
    onOpenGitManager,
    openGitManager,
    encoding.cycleActiveFileEol,
    cycleActiveFileIndentation,
    encoding.openFileEncodingDialog,
    encoding.toggleActiveFileBom,
    activeFile,
    openLanguageServersSettings,
    activeLspProgress,
    lspClientEvents.cancelProgress,
    setWorkspaceStatusActions,
    tabId,
    visible,
  ]);

  useEffect(() => {
    return () => clearWorkspaceStatus(tabId);
  }, [clearWorkspaceStatus, tabId]);
  return { openLanguageServersSettings };
}
