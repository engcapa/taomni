import { useState, useCallback } from "react";
import { type LspDocumentDescriptor } from "../../../../lib/editor/lsp";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import { applyRunOverrideToJavaLaunch, readRunConfigurationOverrides } from "../runConfigurationPersistence";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, type WorkspaceBuildRunTools, errorMessage } from "../codeWorkspaceModel";
import { type JavaMainClassOption } from "../../../../lib/editor/dap";
import { createStartDebugActiveFile, createStartDebugActiveTarget } from "../controller/runActions";


export interface UseWorkspaceDebugLaunchContext {
  activeRunConfigurationOverride: import("../runConfigurationPersistence").RunConfigurationOverride | undefined;
  activeRunConfiguration: import("../../../../lib/editor/workspace").ExecutionRunConfiguration | null;
  buildRunTools: WorkspaceBuildRunTools;
  debug: import("../useCodeDebugSession").CodeDebugSession;
  setStatusMessage: (message: string) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  activeKey: string | null;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  workspaceInstanceId: string;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  saveOpenBufferText: (key: string, textToSave?: string, saveOptions?: { eol?: import("../editorGroupTypes").OpenFileEol | "lf" | "crlf" | "cr"; encoding?: string; bom?: boolean; }, onCommitResult?: (result: import("../saveCommit").SaveCommitResult) => void) => Promise<import("../../../../lib/editor/workspace").WorkspaceFile | null>;
  executeBeforeLaunch: (targetIds: readonly string[], targets: readonly import("../../../../lib/editor/workspace").ExecutionBuildTarget[], root: CodeWorkspaceRootInfo) => Promise<void>;
  activeExecutionModel: import("../../../../lib/editor/workspace").WorkspaceExecutionModel | null;
  prepareJavaLaunch: (rootId: string, launchDescriptor?: LspDocumentDescriptor | null) => Promise<boolean>;
  mountedRef: import("react").MutableRefObject<boolean>;
  readEnvironmentFile: (cwd: string, envFile: string | undefined) => Promise<Record<string, string>>;
  activeFileIsJava: boolean;
  activeDebugConfiguration: import("../../../../lib/editor/workspace").ExecutionDebugConfiguration | null;
  activeDebugConfigurationCatalog: import("../../../../lib/editor/workspace").ExecutionDebugConfiguration[];
  roots: CodeWorkspaceRootInfo[];
}

export function useWorkspaceDebugLaunch(context: UseWorkspaceDebugLaunchContext) {
  const {
    activeRunConfigurationOverride,
    activeRunConfiguration,
    buildRunTools,
    debug,
    setStatusMessage,
    openFilesRef,
    activeKey,
    findRoot,
    absolutePathForOpenFile,
    lspDescriptorForFile,
    workspaceInstanceId,
    setBottomDockTab,
    setBottomDockOpen,
    saveOpenBufferText,
    executeBeforeLaunch,
    activeExecutionModel,
    prepareJavaLaunch,
    mountedRef,
    readEnvironmentFile,
    activeFileIsJava,
    activeDebugConfiguration,
    activeDebugConfigurationCatalog,
    roots,
  } = context;


  /** Pending main-class choice when the active file resolves to several mains. */
  const [javaMainCandidates, setJavaMainCandidates] = useState<{
    candidates: JavaMainClassOption[];
    launch: Record<string, unknown>;
    override?: ReturnType<typeof readRunConfigurationOverrides>[string];
    environment: Record<string, string>;
    runtimeOptions: string[];
  } | null>(null);


  /** Start a Java debug session, optionally pinned to an explicit main class. */
  const launchJavaDebug = useCallback(
    (
      launch: Record<string, unknown>,
      main?: JavaMainClassOption,
      override = activeRunConfigurationOverride,
      environment: Record<string, string> = {},
      runtimeOptions: readonly string[] = activeRunConfiguration?.runtimeOptions ?? [],
    ) => {
      const config = main
        ? { ...launch, mainClass: main.mainClass, projectName: main.projectName }
        : launch;
      const configured = applyRunOverrideToJavaLaunch(config, override, environment, runtimeOptions);
      if (buildRunTools.stepFilters?.enabled) {
        configured.stepFilters = {
          classNameFilters: buildRunTools.stepFilters.patterns,
          skipSynthetics: buildRunTools.stepFilters.skipSynthetics,
          skipStaticInitializers: buildRunTools.stepFilters.skipStaticInitializers,
          skipConstructors: buildRunTools.stepFilters.skipConstructors,
        };
      }
      if (main) {
        // Resolving the classpath + asking java-debug for a port is another
        // multi-second server round trip: name the target so the panel is not
        // blank while it runs.
        debug.reportStartupProgress(`Launching ${main.mainClass}…`);
      }
      void debug.startDebug(configured).catch((err) => setStatusMessage(errorMessage(err)));
    },
    [activeRunConfiguration, activeRunConfigurationOverride, buildRunTools.stepFilters, debug, setStatusMessage],
  );

  /** Build a Java launch config for the active file and start debugging. */
  const startDebugActiveFile = useCallback(createStartDebugActiveFile({
    openFilesRef,
    activeKey,
    findRoot,
    absolutePathForOpenFile,
    lspDescriptorForFile,
    workspaceInstanceId,
    setBottomDockTab,
    setBottomDockOpen,
    debug,
    saveOpenBufferText,
    executeBeforeLaunch,
    activeRunConfiguration,
    activeExecutionModel,
    setStatusMessage,
    prepareJavaLaunch,
    mountedRef,
    readEnvironmentFile,
    setJavaMainCandidates,
    activeRunConfigurationOverride,
    launchJavaDebug,
  }), [
    activeExecutionModel,
    activeKey,
    activeRunConfiguration,
    activeRunConfigurationOverride,
    debug,
    executeBeforeLaunch,
    findRoot,
    lspDescriptorForFile,
    absolutePathForOpenFile,
    launchJavaDebug,
    prepareJavaLaunch,
    readEnvironmentFile,
    saveOpenBufferText,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
    workspaceInstanceId,
  ]);


  const startDebugActiveTarget = useCallback(createStartDebugActiveTarget({
    activeFileIsJava,
    activeRunConfiguration,
    activeDebugConfiguration,
    startDebugActiveFile,
    setStatusMessage,
    openFilesRef,
    activeKey,
    setBottomDockTab,
    setBottomDockOpen,
    debug,
    saveOpenBufferText,
    findRoot,
    activeDebugConfigurationCatalog,
    activeExecutionModel,
    roots,
    readEnvironmentFile,
    executeBeforeLaunch,
  }), [
    activeDebugConfiguration,
    activeDebugConfigurationCatalog,
    activeExecutionModel,
    activeFileIsJava,
    activeKey,
    debug,
    executeBeforeLaunch,
    findRoot,
    readEnvironmentFile,
    roots,
    saveOpenBufferText,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
    startDebugActiveFile,
  ]);
  return { startDebugActiveTarget, launchJavaDebug, javaMainCandidates, setJavaMainCandidates };
}
