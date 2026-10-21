import { useCallback, useMemo } from "react";
import { promptAppDialog } from "../../../../lib/appDialogs";
import { type LspDocumentDescriptor } from "../../../../lib/editor/lsp";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { errorMessage, fsPathEquals, normalizeFsPath, type OpenFileState } from "../codeWorkspaceModel";
import { javaMainRunLines, type RunGutterTarget } from "../runGutter";


export interface UseWorkspaceDebugEntryPointsContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  activeFileIsJava: boolean;
  activeRunConfiguration: import("../../../../lib/editor/workspace").ExecutionRunConfiguration | null;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  openEditorContextMenuAt: (x: number, y: number, items: import("../../../ContextMenu").MenuItem[], menuOptions?: import("../../../ContextMenu").ContextMenuAppearance) => void;
  runActiveJavaFileRef: import("react").RefObject<() => void>;
  startDebugActiveTarget: () => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  activeKey: string | null;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  setStatusMessage: (message: string) => void;
  debug: import("../useCodeDebugSession").CodeDebugSession;
  workspaceInstanceId: string;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
}

export function useWorkspaceDebugEntryPoints(context: UseWorkspaceDebugEntryPointsContext) {
  const {
    activeFile,
    activeFileIsJava,
    activeRunConfiguration,
    absolutePathForOpenFile,
    openEditorContextMenuAt,
    runActiveJavaFileRef,
    startDebugActiveTarget,
    openFilesRef,
    activeKey,
    findRoot,
    lspDescriptorForFile,
    setStatusMessage,
    debug,
    workspaceInstanceId,
    setBottomDockTab,
    setBottomDockOpen,
  } = context;

  // ED-PARITY-022 DEC-022-03: run gutter ▶ only where a detected run
  // configuration of this very file exists (no facts → no icon).
  const runGutterKey = useMemo(() => {
    if (!activeFile || !activeFileIsJava || !activeRunConfiguration?.sourceFile) return "";
    const absolute = absolutePathForOpenFile(activeFile);
    if (!absolute || !fsPathEquals(normalizeFsPath(activeRunConfiguration.sourceFile), normalizeFsPath(absolute))) return "";
    const { classLine, mainLine } = javaMainRunLines(activeFile.text);
    if (mainLine === null) return "";
    return JSON.stringify({
      label: activeRunConfiguration.label,
      lines: classLine !== null && classLine !== mainLine ? [classLine, mainLine] : [mainLine],
    });
  }, [absolutePathForOpenFile, activeFile, activeFileIsJava, activeRunConfiguration]);
  const activeRunGutterTargets = useMemo<RunGutterTarget[]>(() => {
    if (!runGutterKey) return [];
    const parsed = JSON.parse(runGutterKey) as { label: string; lines: number[]; };
    return parsed.lines.map((line) => ({ line, label: parsed.label }));
  }, [runGutterKey]);
  const handleRunGutterClick = useCallback((target: RunGutterTarget, anchor: { x: number; y: number; }) => {
    openEditorContextMenuAt(anchor.x, anchor.y, [
      {
        label: `Run '${target.label}'`,
        testId: "code-workspace-run-gutter-run",
        shortcut: "Ctrl+Shift+F10",
        onClick: () => { void runActiveJavaFileRef.current(); },
      },
      {
        label: `Debug '${target.label}'`,
        testId: "code-workspace-run-gutter-debug",
        onClick: () => startDebugActiveTarget(),
      },
    ]);
  }, [openEditorContextMenuAt, startDebugActiveTarget]);

  /**
   * Attach to a JVM already running with `-agentlib:jdwp=...,server=y,address=…`
   * (IDEA's "Remote JVM Debug"). The active file still selects the jdtls session
   * so breakpoints resolve against this project's sources.
   */
  const attachRemoteDebug = useCallback(() => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return;
    const root = findRoot(file.ref.rootId);
    const absolute = absolutePathForOpenFile(file);
    if (!root || !absolute) return;
    const descriptor = lspDescriptorForFile(file);
    void (async () => {
      const target = await promptAppDialog({
        title: "Attach to remote JVM",
        label: "Debug address — host:port, or just the port for localhost",
        initialValue: "localhost:5005",
      });
      if (target === null) return;
      const trimmed = target.trim();
      if (!trimmed) return;
      const [hostPart, portPart] = trimmed.includes(":")
        ? [trimmed.slice(0, trimmed.lastIndexOf(":")), trimmed.slice(trimmed.lastIndexOf(":") + 1)]
        : ["localhost", trimmed];
      const port = Number.parseInt(portPart, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        setStatusMessage(`Not a valid debug address: ${trimmed}`);
        return;
      }
      try {
        await debug.startDebug({
          workspaceId: descriptor?.workspaceId ?? workspaceInstanceId,
          rootPath: root.path,
          filePath: absolute,
          request: "attach",
          hostName: hostPart || "localhost",
          port,
          serverCommandId: descriptor?.serverCommandId ?? null,
          customServerCommand: descriptor?.customServerCommand ?? null,
        });
        setBottomDockTab("debug");
        setBottomDockOpen(true);
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    })();
  }, [
    activeKey, debug, findRoot, lspDescriptorForFile, absolutePathForOpenFile,
    setBottomDockOpen, setBottomDockTab, setStatusMessage, workspaceInstanceId,
  ]);
  return { activeRunGutterTargets, handleRunGutterClick, attachRemoteDebug };
}
