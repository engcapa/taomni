import { useCallback, useRef, useState } from "react";
import { type LspDocumentDescriptor } from "../../../../lib/editor/lsp";
import { isTauriRuntime } from "../../../../lib/runtime";
import { type CodeWorkspaceGitManagerPayload } from "../controller/model";
import { createPrepareJavaLaunch } from "../controller/projectLaunch";
import { useCodeDebugSession } from "../useCodeDebugSession";
import { useBreakpointControls } from "./useBreakpointControls";
import { useDebugSourceNavigation } from "./useDebugSourceNavigation";
import { useExecutionTargets } from "./useExecutionTargets";
import type { useWorkspaceActionPorts } from "./useWorkspaceActionPorts";
import { useWorkspaceContextPublication } from "./useWorkspaceContextPublication";
import { useWorkspaceDebugEntryPoints } from "./useWorkspaceDebugEntryPoints";
import { useWorkspaceDebugLaunch } from "./useWorkspaceDebugLaunch";
import type { useWorkspaceDocumentEditing } from "./useWorkspaceDocumentEditing";
import type { useWorkspaceFileOpening } from "./useWorkspaceFileOpening";
import type { useWorkspaceIntelligenceRuntime } from "./useWorkspaceIntelligenceRuntime";
import type { useWorkspaceProjectRuntime } from "./useWorkspaceProjectRuntime";
import { useWorkspaceRunActions } from "./useWorkspaceRunActions";
import type { useWorkspaceSemanticFeatures } from "./useWorkspaceSemanticFeatures";
import type { useWorkspaceSession } from "./useWorkspaceSession";
import type { useWorkspaceSurfaceState } from "./useWorkspaceSurfaceState";
import { useWorkspaceTests } from "./useWorkspaceTests";
import { relativePathWithinRoot } from "../codeWorkspaceModel";


export interface UseWorkspaceExecutionRuntimeContext {
  editing: ReturnType<typeof useWorkspaceDocumentEditing>;
  session: ReturnType<typeof useWorkspaceSession>;
  project: ReturnType<typeof useWorkspaceProjectRuntime>;
  ports: ReturnType<typeof useWorkspaceActionPorts>;
  insight: ReturnType<typeof useWorkspaceIntelligenceRuntime>;
  files: ReturnType<typeof useWorkspaceFileOpening>;
  semantics: ReturnType<typeof useWorkspaceSemanticFeatures>;
  surfaceState: ReturnType<typeof useWorkspaceSurfaceState>;
  onSyncGitManager: ((payload: CodeWorkspaceGitManagerPayload) => void) | undefined;
  tabId: string;
  workspace: import("../../../../types").CodeWorkspaceTabInfo;
}

export function useWorkspaceExecutionRuntime(context: UseWorkspaceExecutionRuntimeContext) {
  const { onSyncGitManager, tabId, workspace, editing, session, project, ports, insight, files, semantics, surfaceState } = context;

  // M8 E: Java test discovery + terminal run. Discovery targets the active .java
  // file; running builds a Maven/Gradle command and reuses the terminal runner.
  const activeFileIsJava = !!editing.documentLanguage.activeFile
    && !editing.documentLanguage.activeFile.library
    && editing.documentLanguage.activeFile.languagePath.toLowerCase().endsWith(".java");
  const [javaRunBusy, setJavaRunBusy] = useState(false);
  const [projectBuildBusy, setProjectBuildBusy] = useState(false);
  const execution = useExecutionTargets({
    isEditorReady: session.editorCommands.isActiveEditorReady,
    workspaceInstanceId: session.workspaceInstanceId,
    openFilesRef: session.bufferState.openFilesRef,
    activeKey: session.workspaceUi.activeKey,
    findRoot: project.projectTree.findRoot,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    toolConfigRef: project.buildTools.toolConfigRef,
    activeFileIsJava,
    setStatusMessage: session.setStatusMessage,
    toolConfig: project.buildTools.toolConfig,
    activeFile: editing.documentLanguage.activeFile,
    roots: project.projectTree.roots,
    projectDetected: project.projectDescriptorDiscovery.discovery?.descriptors.some((descriptor) => {
      const file = editing.documentLanguage.activeFile;
      const path = file && editing.absolutePathForOpenFile(file);
      return !!path && relativePathWithinRoot(descriptor.root, path) !== null;
    }),
  });
  const runActions = useWorkspaceRunActions({
    runPanelRef: ports.runPanelRef,
    runWorkspaceTask: project.buildTools.runWorkspaceTask,
    workspaceInstanceId: session.workspaceInstanceId,
    activeExecutionModel: execution.activeExecutionModel,
    runConfigurationRevision: execution.runConfigurationRevision,
    javaRunBusy,
    openFilesRef: session.bufferState.openFilesRef,
    activeKey: session.workspaceUi.activeKey,
    findRoot: project.projectTree.findRoot,
    setJavaRunBusy,
    saveOpenBufferText: editing.saves.saveOpenBufferText,
    toolConfigRef: project.buildTools.toolConfigRef,
    setStatusMessage: session.setStatusMessage,
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
    activeRunConfiguration: execution.activeRunConfiguration,
    activeFileIsJava,
    projectBuildBusy,
    rootsRef: project.projectTree.rootsRef,
    setProjectBuildBusy,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    saveFile: editing.saves.saveFile,
    runActiveJavaFileRef: ports.runActiveJavaFileRef,
    buildActiveProjectRef: ports.buildActiveProjectRef,
    recompileActiveFileRef: ports.recompileActiveFileRef,
  });
  const tests = useWorkspaceTests({
    openFilesRef: session.bufferState.openFilesRef,
    activeKey: session.workspaceUi.activeKey,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    findRoot: project.projectTree.findRoot,
    mountedRef: session.mountedRef,
    workspaceInstanceId: session.workspaceInstanceId,
    bottomDockOpen: session.workspaceUi.bottomDockOpen,
    bottomDockTab: session.workspaceUi.bottomDockTab,
    activeFileIsJava,
    activeFile: editing.documentLanguage.activeFile,
    toolConfigRef: project.buildTools.toolConfigRef,
    runWorkspaceTask: project.buildTools.runWorkspaceTask,
    setStatusMessage: session.setStatusMessage,
    problemPathToRef: insight.projectDiagnostics.problemPathToRef,
    openFile: files.openFile,
    revealEditorLocation: semantics.librarySources.revealEditorLocation,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
    get prepareJavaLaunchRef() { return prepareJavaLaunchRef; },
    debugRef: ports.debugRef,
  });

  // M9: debug session (breakpoints, stepping, variables, watch, console).
  const debug = useCodeDebugSession(session.workspaceInstanceId);
  // Ref so callbacks declared above the hook (debug-test, commands) can reach it.
  ports.debugRef.current = debug;
  // Ref so debug-test (declared above prepareJavaLaunch) can reach the pre-launch
  // save+build gate without a forward reference.
  const prepareJavaLaunchRef = useRef<
    (rootId: string, launchDescriptor?: LspDocumentDescriptor | null) => Promise<boolean>
  >(() => Promise.resolve(true));
  const breakpoints = useBreakpointControls({
    activeFile: editing.documentLanguage.activeFile,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    debug,
    rootRef: surfaceState.rootRef,
    toggleActiveBreakpointRef: ports.toggleActiveBreakpointRef,
    editActiveBreakpointRef: ports.editActiveBreakpointRef,
    viewBreakpointsAtCaretRef: ports.viewBreakpointsAtCaretRef,
    addActiveBreakpointRef: ports.addActiveBreakpointRef,
    toggleActiveBreakpointEnabledRef: ports.toggleActiveBreakpointEnabledRef,
    toggleTemporaryBreakpointRef: ports.toggleTemporaryBreakpointRef,
    openEvaluateDialogRef: ports.openEvaluateDialogRef,
    editorSelectionRef: session.editorSelectionRef,
  });

  /**
   * Make-before-launch (Phase 3): save every dirty Java / build file in the
   * project, wait for the jdtls build barrier, then block the launch when the
   * compiler itself reports errors (`failed` / `withError`) — so the debuggee
   * never runs stale bytecode and source lines match the loaded classes.
   * Returns true when it is safe to launch. jdtls / build being unavailable is
   * NOT a block here (the DAP path surfaces those), and a clean build launches
   * even if stale or foreign-language diagnostics sit in the workspace store:
   * published diagnostics are not a compiler verdict, and sweeping them all
   * used to hijack the bottom dock onto Problems for projects that compile.
   */
  const prepareJavaLaunch = useCallback(createPrepareJavaLaunch({
    findRoot: project.projectTree.findRoot,
    openFilesRef: session.bufferState.openFilesRef,
    saveOpenBufferText: editing.saves.saveOpenBufferText,
    setStatusMessage: session.setStatusMessage,
    debug,
    lspDescriptorForPath: project.lsp.descriptorForPath,
    setProblemsScope: insight.projectDiagnostics.setProblemsScope,
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
    mountedRef: session.mountedRef,
  }), [
    debug, project.projectTree.findRoot, editing.saves.saveOpenBufferText, project.lsp.saveDocument, project.lsp.descriptorForPath,
    project.toolWindowRouting.setBottomDockOpen, project.toolWindowRouting.setBottomDockTab, insight.projectDiagnostics.setProblemsScope, session.setStatusMessage,
  ]);
  prepareJavaLaunchRef.current = prepareJavaLaunch;
  const debugLaunch = useWorkspaceDebugLaunch({
    activeRunConfigurationOverride: execution.activeRunConfigurationOverride,
    activeRunConfiguration: execution.activeRunConfiguration,
    buildRunTools: project.buildTools.buildRunTools,
    debug,
    setStatusMessage: session.setStatusMessage,
    openFilesRef: session.bufferState.openFilesRef,
    activeKey: session.workspaceUi.activeKey,
    findRoot: project.projectTree.findRoot,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    workspaceInstanceId: session.workspaceInstanceId,
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
    saveOpenBufferText: editing.saves.saveOpenBufferText,
    executeBeforeLaunch: runActions.executeBeforeLaunch,
    activeExecutionModel: execution.activeExecutionModel,
    prepareJavaLaunch,
    mountedRef: session.mountedRef,
    readEnvironmentFile: runActions.readEnvironmentFile,
    activeFileIsJava,
    activeDebugConfiguration: execution.activeDebugConfiguration,
    activeDebugConfigurationCatalog: execution.activeDebugConfigurationCatalog,
    roots: project.projectTree.roots,
  });
  const debugEntryPoints = useWorkspaceDebugEntryPoints({
    activeFile: editing.documentLanguage.activeFile,
    activeFileIsJava,
    activeRunConfiguration: execution.activeRunConfiguration,
    absolutePathForOpenFile: editing.absolutePathForOpenFile,
    openEditorContextMenuAt: files.treeInteractions.openEditorContextMenuAt,
    runActiveJavaFileRef: ports.runActiveJavaFileRef,
    startDebugActiveTarget: debugLaunch.startDebugActiveTarget,
    openFilesRef: session.bufferState.openFilesRef,
    activeKey: session.workspaceUi.activeKey,
    findRoot: project.projectTree.findRoot,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    setStatusMessage: session.setStatusMessage,
    debug,
    workspaceInstanceId: session.workspaceInstanceId,
    setBottomDockTab: project.toolWindowRouting.setBottomDockTab,
    setBottomDockOpen: project.toolWindowRouting.setBottomDockOpen,
  });
  const { openDebugFrame } = useDebugSourceNavigation({
    problemPathToRef: insight.projectDiagnostics.problemPathToRef,
    openFile: files.openFile,
    revealEditorLocation: semantics.librarySources.revealEditorLocation,
    openFilesRef: session.bufferState.openFilesRef,
    activeKey: session.workspaceUi.activeKey,
    lspDescriptorForFile: project.lsp.descriptorForFile,
    debugRef: ports.debugRef,
    setStatusMessage: session.setStatusMessage,
    openLibraryBuffer: semantics.librarySources.openLibraryBuffer,
    debug,
    showDebugExecutionPointRef: ports.showDebugExecutionPointRef,
  });

  // Real Java debugging drives the DAP kernel over Tauri IPC, which the browser
  // dev-preview stubs cannot provide (there is no JVM / java-debug adapter). Gate
  // the debug entry points on the desktop runtime so preview shows a clear reason
  // instead of crashing on an undefined `dap_start_session` result. Plain Java Run
  // uses the PTY and stays available, so it is deliberately not gated here.
  const debugRuntimeAvailable = isTauriRuntime();
  const activeFileJavaRoot = !!activeFileIsJava && !!editing.documentLanguage.activeFile && editing.documentLanguage.activeFile.ref.kind === "root";
  const activeFileRunnable = execution.activeRunConfiguration
    ? execution.activeRunConfiguration.kind !== "debug-only" && !execution.activeRunConfiguration.command.error
    : activeFileJavaRoot && execution.activeExecutionModel !== null;
  const activeFileDebuggable = debugRuntimeAvailable && (
    execution.activeDebugConfiguration
      ? execution.activeDebugConfiguration.available === true
      : activeFileJavaRoot
      && !execution.activeRunConfiguration?.debugConfigurationId
      && execution.activeRunConfiguration?.kind !== "debug-only"
  );
  useWorkspaceContextPublication({
    onSyncGitManager,
    gitManagerPayload: semantics.gitManagerPayload,
    roots: project.projectTree.roots,
    openOrder: session.workspaceUi.openOrder,
    deferredOpenFiles: semantics.deferredOpenFiles,
    looseFiles: project.projectTree.looseFiles,
    inspections: project.inspections,
    lspFiles: session.workspaceUi.lspFiles,
    activeLspState: editing.documentLanguage.activeLspState,
    tabId,
    workspace,
    deferredActiveFile: insight.deferredActiveFile,
    dirtyFiles: insight.dirtyFiles,
  });
  return {
    debug,
    breakpoints,
    debugEntryPoints,
    activeFileIsJava,
    tests,
    activeFileDebuggable,
    debugLaunch,
    activeFileJavaRoot,
    debugRuntimeAvailable,
    openDebugFrame,
    execution,
    projectBuildBusy,
    runActions,
    javaRunBusy,
    activeFileRunnable,
  };
}
