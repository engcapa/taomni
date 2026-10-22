import {
  Activity,
  AlertTriangle,
  Braces,
  Bug,
  FlaskConical,
  GitBranch,
  GitFork,
  Hammer,
  ListTodo,
  ListTree,
  Network,
  Play,
  Search,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { lspJavaModules, type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import type { StructuralMatch } from "../../../../lib/editor/structuralSearch";
import { type WorkspaceToolConfig } from "../../../../lib/editor/workspace";
import type { WorkspaceSearchMatch } from "../../../../lib/editor/workspaceSearch";
import { type BottomDockTabId, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { WorkspaceGitManager } from "../../../git/WorkspaceGitManager";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { fileKey, type LspFileState, type OpenFileState } from "../codeWorkspaceModel";
import { useProjectDiagnostics } from "../controller/useProjectDiagnostics";
import { useWorkspacePreferences } from "../controller/useWorkspacePreferences";
import { useBreakpointControls } from "../hooks/useBreakpointControls";
import { useExecutionTargets } from "../hooks/useExecutionTargets";
import { useIntentionActions } from "../hooks/useIntentionActions";
import { useWorkspaceBookmarkActions } from "../hooks/useWorkspaceBookmarkActions";
import { useWorkspaceCoverage } from "../hooks/useWorkspaceCoverage";
import { useWorkspaceDebugEntryPoints } from "../hooks/useWorkspaceDebugEntryPoints";
import { useWorkspaceDebugLaunch } from "../hooks/useWorkspaceDebugLaunch";
import { useWorkspaceEditorTelemetry } from "../hooks/useWorkspaceEditorTelemetry";
import { useWorkspaceHierarchy } from "../hooks/useWorkspaceHierarchy";
import { useWorkspaceInspections } from "../hooks/useWorkspaceInspections";
import { useWorkspaceLibrarySources } from "../hooks/useWorkspaceLibrarySources";
import { useWorkspaceProblemPresentation } from "../hooks/useWorkspaceProblemPresentation";
import { useWorkspaceStatusBridge } from "../hooks/useWorkspaceStatusBridge";
import { useWorkspaceTests } from "../hooks/useWorkspaceTests";
import { useWorkspaceUsages } from "../hooks/useWorkspaceUsages";
import { useWorkspaceUsagesState } from "../hooks/useWorkspaceUsagesState";
import { languageServiceReadiness } from "../languageServiceReadiness";
import { AnalysisPanel } from "../panels/AnalysisPanel";
import { type BottomDockTab } from "../panels/BottomDock";
import { BuildPanel } from "../panels/BuildPanel";
import { CoveragePanel } from "../panels/CoveragePanel";
import { DebugPanel } from "../panels/DebugPanel";
import { FindInFilesPanel } from "../panels/FindInFilesPanel";
import { HierarchyPanel } from "../panels/HierarchyPanel";
import { ProblemsPanel, type ProblemFileGroup } from "../panels/ProblemsPanel";
import { ReferencesPanel } from "../panels/ReferencesPanel";
import { RunPanel, type RunPanelHandle, type WorkspaceTaskItem } from "../panels/RunPanel";
import { StructuralSearchPanel } from "../panels/StructuralSearchPanel";
import { TerminalDockPanel, type TerminalDockHandle } from "../panels/TerminalDockPanel";
import { TestsPanel } from "../panels/TestsPanel";
import { TodosBookmarksPanel } from "../panels/TodosBookmarksPanel";
import { type ReplaceFilePreimage, type ReplacePrepareOptions } from "../replaceInFilesModel";
import { applyRunOverrideToDebugConfiguration, readRunConfigurationOverrides, writeActiveRunConfigurationSelection } from "../runConfigurationPersistence";
import { useCodeDebugSession } from "../useCodeDebugSession";
import { useDeferredOpenFileTodos } from "../useDeferredOpenFileTodos";
import { useStructuralSearchSession } from "../useStructuralSearchSession";
import { useWorkspaceGitSnapshots } from "../useWorkspaceGitSnapshots";
import { useWorkspaceLspSession } from "../useWorkspaceLspSession";
import { useWorkspaceProjectAnalysis } from "../useWorkspaceProjectAnalysis";
import { useWorkspaceSemanticIndex } from "../useWorkspaceSemanticIndex";


export interface CreateWorkspaceDockContentsContext {
  problems: ReturnType<typeof useWorkspaceProblemPresentation>;
  problemsScopeFiles: ProblemFileGroup[];
  intentions: ReturnType<typeof useIntentionActions>;
  inspections: ReturnType<typeof useWorkspaceInspections>;
  projectDiagnostics: ReturnType<typeof useProjectDiagnostics>;
  activeCapabilities: import("../../../../lib/editor/lsp").LspCapabilitySummary | null;
  activeKey: string | null;
  activeLspState: LspFileState | null;
  statusBridge: ReturnType<typeof useWorkspaceStatusBridge>;
  lsp: ReturnType<typeof useWorkspaceLspSession>;
  analysisFiles: ProblemFileGroup[];
  telemetry: ReturnType<typeof useWorkspaceEditorTelemetry>;
  activeEditorGroupId: string;
  semanticIndex: ReturnType<typeof useWorkspaceSemanticIndex>;
  projectAnalysis: ReturnType<typeof useWorkspaceProjectAnalysis>;
  librarySources: ReturnType<typeof useWorkspaceLibrarySources>;
  roots: CodeWorkspaceRootInfo[];
  workspaceInstanceId: string;
  searchFocusNonce: number;
  searchFocusTarget: "query" | "replace";
  searchIncludePreset: { value: string; nonce: number; };
  searchQueryPreset: { value: string; nonce: number; };
  openSearchMatch: (match: WorkspaceSearchMatch, options: { preview: boolean; }) => void;
  prepareReplacePreimages: (paths: readonly string[], options?: ReplacePrepareOptions) => Promise<readonly ReplaceFilePreimage[]>;
  replaceMatches: ((matches: WorkspaceSearchMatch[], replacement: string, edit: LspWorkspaceEdit, snapshot: import("../replaceInFilesModel").ReplacePreviewSnapshot) => Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string; }>) | undefined;
  structuralSearch: ReturnType<typeof useStructuralSearchSession>;
  openStructuralMatch: (match: StructuralMatch, options: { preview: boolean; }) => void;
  usages: ReturnType<typeof useWorkspaceUsagesState>;
  usagesActions: ReturnType<typeof useWorkspaceUsages>;
  hierarchy: ReturnType<typeof useWorkspaceHierarchy>;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  openFileTodos: ReturnType<typeof useDeferredOpenFileTodos>;
  preferences: ReturnType<typeof useWorkspacePreferences>;
  openTodoOrBookmark: (item: { fileKey: string; pathLabel?: string; line: number; character: number; state?: import("../todoBookmarks").WorkspaceBookmark["state"]; }) => Promise<boolean>;
  bookmarkActions: ReturnType<typeof useWorkspaceBookmarkActions>;
  terminalDockRef: import("react").RefObject<TerminalDockHandle | null>;
  activeRoot: CodeWorkspaceRootInfo | null;
  runPanelRef: import("react").RefObject<RunPanelHandle | null>;
  runWorkspaceTask: (task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => void;
  toolConfig: WorkspaceToolConfig | undefined;
  setBuildRunToolsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  activeFileIsJava: boolean;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  tests: ReturnType<typeof useWorkspaceTests>;
  coverage: ReturnType<typeof useWorkspaceCoverage>;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  gitSnapshotOwner: ReturnType<typeof useWorkspaceGitSnapshots>;
  gitToolWindowMounted: boolean;
  title: string;
  activeGitRoot: import("../../../../lib/editor/workspace").WorkspaceGitRoot | null;
  debug: ReturnType<typeof useCodeDebugSession>;
  activeFileDebuggable: boolean;
  debugLaunch: ReturnType<typeof useWorkspaceDebugLaunch>;
  activeFileJavaRoot: boolean;
  debugRuntimeAvailable: boolean;
  debugEntryPoints: ReturnType<typeof useWorkspaceDebugEntryPoints>;
  openDebugFrame: (frame: Pick<import("../dapDebugModel").DebugStackFrame, "path" | "line"> & Partial<Pick<import("../dapDebugModel").DebugStackFrame, "sourceReference" | "sourceName" | "name">> & { column?: number; }) => void;
  breakpoints: ReturnType<typeof useBreakpointControls>;
  openEvaluateDialogRef: import("react").RefObject<(expression?: string) => void>;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  execution: ReturnType<typeof useExecutionTargets>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
}

export function createWorkspaceDockContents(context: CreateWorkspaceDockContentsContext) {
  const {
    problems,
    problemsScopeFiles,
    intentions,
    inspections,
    projectDiagnostics,
    activeCapabilities,
    activeKey,
    activeLspState,
    statusBridge,
    lsp,
    analysisFiles,
    telemetry,
    activeEditorGroupId,
    semanticIndex,
    projectAnalysis,
    librarySources,
    roots,
    workspaceInstanceId,
    searchFocusNonce,
    searchFocusTarget,
    searchIncludePreset,
    searchQueryPreset,
    openSearchMatch,
    prepareReplacePreimages,
    replaceMatches,
    structuralSearch,
    openStructuralMatch,
    usages,
    usagesActions,
    hierarchy,
    bottomDockOpen,
    bottomDockTab,
    openFileTodos,
    preferences,
    openTodoOrBookmark,
    bookmarkActions,
    terminalDockRef,
    activeRoot,
    runPanelRef,
    runWorkspaceTask,
    toolConfig,
    setBuildRunToolsOpen,
    activeFileIsJava,
    activeFile,
    tests,
    coverage,
    openFile,
    gitSnapshotOwner,
    gitToolWindowMounted,
    title,
    activeGitRoot,
    debug,
    activeFileDebuggable,
    debugLaunch,
    activeFileJavaRoot,
    debugRuntimeAvailable,
    debugEntryPoints,
    openDebugFrame,
    breakpoints,
    openEvaluateDialogRef,
    editorSelectionRef,
    execution,
    absolutePathForOpenFile,
  } = context;

  const bottomDockTabs: BottomDockTab[] = [
    {
      id: "problems",
      label: "Problems",
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
      badge: problems.activeProblemCounts.errors > 0 || problems.activeProblemCounts.warnings > 0 ? (
        <span className="inline-flex items-center gap-1">
          {problems.activeProblemCounts.errors > 0 && <span className="text-red-500">{problems.activeProblemCounts.errors}</span>}
          {problems.activeProblemCounts.warnings > 0 && <span className="text-amber-500">{problems.activeProblemCounts.warnings}</span>}
        </span>
      ) : undefined,
      content: (
        <ProblemsPanel
          files={problemsScopeFiles}
          onOpenProblem={problems.openProblem}
          onQuickFix={(fileKey, diagnostic) => void intentions.openQuickFixForProblem(fileKey, diagnostic)}
          onSuppress={inspections.suppressInspection}
          onAddToBaseline={inspections.addInspectionBaseline}
          scope={projectDiagnostics.problemsScope}
          onScopeChange={projectDiagnostics.setProblemsScope}
          onRebuild={() => void projectDiagnostics.rebuildProject()}
          rebuilding={projectDiagnostics.rebuildingProject}
          loading={projectDiagnostics.problemsScope === "project" && projectDiagnostics.projectProblemsLoading}
          diagnosticTransform={inspections.inspectionTransform}
          onOpenRelatedInformation={problems.openRelatedDiagnostic}
          evidenceLine={problems.evidenceLineForProblem}
          suppressedInSource={problems.suppressedInSourceForProblem}
          fullProjectNote={activeCapabilities?.workspaceDiagnostics === true
            ? null
            : "On-the-fly diagnostics only — this server does not expose workspace-wide diagnostics."}
          readiness={activeKey ? languageServiceReadiness(activeLspState) : null}
          onConfigureLanguageService={() => statusBridge.openLanguageServersSettings(activeLspState?.status?.presetId)}
          onRetryLanguageService={lsp.restartServers}
        />
      ),
    },
    {
      id: "analysis",
      label: "Analysis",
      icon: <Activity className="h-3.5 w-3.5" />,
      badge: problems.activeProblemCounts.errors + problems.activeProblemCounts.warnings || undefined,
      content: (
        <AnalysisPanel
          files={analysisFiles}
          status={activeLspState?.status ?? null}
          semanticTokenCount={telemetry.semanticTokensByGroup[activeEditorGroupId]?.length ?? 0}
          semanticIndex={semanticIndex.snapshot}
          projectAnalysis={projectAnalysis.snapshot}
          projectAnalysisProbing={projectAnalysis.probing}
          onRefreshProjectAnalysis={projectAnalysis.refresh}
          profile={inspections.inspectionProfile}
          onUpdateRule={inspections.updateInspectionProfileRule}
          onCreateBaseline={problems.createInspectionBaselineFromScope}
          onClearBaseline={inspections.clearInspectionBaselineEntries}
          onRemoveBaselineEntry={inspections.removeInspectionBaseline}
          onRemoveSuppression={inspections.removeInspectionSuppressionEntry}
          onExportBaseline={() => void inspections.exportInspectionBaseline()}
          onImportBaseline={() => void inspections.importInspectionBaselineFromClipboard()}
          onOpenLocation={(location) => void librarySources.openLspLocation(location)}
          onOpenDiagnostic={problems.openProblem}
        />
      ),
    },
    {
      id: "search",
      label: "Search",
      icon: <Search className="h-3.5 w-3.5" />,
      content: (
        <FindInFilesPanel
          roots={roots}
          workspaceInstanceId={workspaceInstanceId}
          focusNonce={searchFocusNonce}
          focusTarget={searchFocusTarget}
          includePreset={searchIncludePreset}
          queryPreset={searchQueryPreset}
          onOpenMatch={openSearchMatch}
          onPrepareReplacePreimages={prepareReplacePreimages}
          onReplaceMatches={replaceMatches}
        />
      ),
    },
    {
      id: "structural",
      label: "Structural Search",
      icon: <Braces className="h-3.5 w-3.5" />,
      badge: structuralSearch.result?.matches.length || undefined,
      content: (
        <StructuralSearchPanel session={structuralSearch} onOpenMatch={openStructuralMatch} />
      ),
    },
    {
      id: "references",
      label: "References",
      icon: <ListTree className="h-3.5 w-3.5" />,
      badge: usages.referencesResult.locations.length,
      content: (
        <ReferencesPanel
          result={usages.referencesResult}
          roots={roots}
          semanticIndex={semanticIndex.snapshot}
          onOpenLocation={(location) => void librarySources.openLspLocation(location)}
          pinned={usages.referencesPinned}
          onPinChange={usages.setPinned}
          onRerun={usagesActions.rerunFindReferences}
          scopeSelection={usages.usagesScopeSelection}
          recentSessions={usages.recentSessions}
          onRestoreRecent={usages.restoreRecent}
          recentsRevision={usages.usagesRecentsRevision}
        />
      ),
    },
    {
      id: "call-hierarchy",
      label: "Call Hierarchy",
      icon: <GitFork className="h-3.5 w-3.5" />,
      content: (
        <HierarchyPanel
          {...hierarchy.hierarchyPanelProps("call")}
          active={bottomDockOpen && bottomDockTab === "call-hierarchy"}
          onOpenLocation={(location) => void librarySources.openLspLocation(location)}
        />
      ),
    },
    {
      id: "type-hierarchy",
      label: "Type Hierarchy",
      icon: <Network className="h-3.5 w-3.5" />,
      content: (
        <HierarchyPanel
          {...hierarchy.hierarchyPanelProps("type")}
          active={bottomDockOpen && bottomDockTab === "type-hierarchy"}
          onOpenLocation={(location) => void librarySources.openLspLocation(location)}
        />
      ),
    },
    {
      id: "todos",
      label: "TODOs",
      icon: <ListTodo className="h-3.5 w-3.5" />,
      badge: (openFileTodos.length + preferences.bookmarks.length) > 0 ? (openFileTodos.length + preferences.bookmarks.length) : undefined,
      content: (
        <TodosBookmarksPanel
          todos={openFileTodos}
          bookmarks={preferences.bookmarks}
          onOpenTodo={(item) => void openTodoOrBookmark(item)}
          onOpenBookmark={(item) => void openTodoOrBookmark(item)}
          onRemoveBookmark={bookmarkActions.removeBookmark}
          onRenameBookmarkGroup={bookmarkActions.renameBookmarkGroup}
        />
      ),
    },
    {
      id: "terminal",
      label: "Terminal",
      icon: <TerminalSquare className="h-3.5 w-3.5" />,
      badge: undefined,
      content: (
        <TerminalDockPanel
          ref={terminalDockRef}
          workspaceInstanceId={workspaceInstanceId}
          roots={roots}
          defaultCwd={activeRoot?.path ?? roots[0]?.path ?? ""}
          active={bottomDockOpen && bottomDockTab === "terminal"}
        />
      ),
    },
    {
      id: "run",
      label: "Run",
      icon: <Play className="h-3.5 w-3.5" />,
      content: (
        <RunPanel
          ref={runPanelRef}
          workspaceInstanceId={workspaceInstanceId}
          roots={roots}
          active={bottomDockOpen && bottomDockTab === "run"}
          onRun={runWorkspaceTask}
          toolConfig={toolConfig}
          onConfigureTools={() => setBuildRunToolsOpen(true)}
        />
      ),
    },
    {
      id: "build",
      label: "Build",
      icon: <Hammer className="h-3.5 w-3.5" />,
      content: (
        <BuildPanel
          workspaceInstanceId={workspaceInstanceId}
          roots={roots}
          active={bottomDockOpen && bottomDockTab === "build"}
          onRunTask={(task, onExit) => runWorkspaceTask(task, onExit)}
          toolConfig={toolConfig}
          onLoadModules={(rootPath) =>
            // A synthetic .java path selects the root's jdtls session
            // (session keys on project scope, not on the file existing).
            lspJavaModules(lsp.descriptorForPath(rootPath, "__taomni_modules__.java"))}
        />
      ),
    },
    {
      id: "tests",
      label: "Tests",
      icon: <FlaskConical className="h-3.5 w-3.5" />,
      content: (
        <TestsPanel
          activeFileTitle={activeFileIsJava ? activeFile?.title ?? null : null}
          canDiscover={activeFileIsJava}
          active={bottomDockOpen && bottomDockTab === "tests"}
          onDiscover={tests.discoverActiveJavaTests}
          onRun={tests.runJavaTest}
          onRerun={tests.rerunStructuredTest}
          onLoadResults={activeFile?.ref.kind === "root" ? tests.loadActiveJavaTestResults : undefined}
          results={activeFile?.ref.kind === "root" ? tests.testResultsByRoot[activeFile.ref.rootId] ?? null : null}
          onOpenFailure={tests.openStructuredTestFailure}
          onDebug={tests.debugJavaTest}
          runDisabled={tests.javaTestBuildTool === null}
        />
      ),
    },
    {
      id: "coverage",
      label: "Coverage",
      icon: <ShieldCheck className="h-3.5 w-3.5" />,
      badge: coverage.coverageReport ? `${coverage.coverageReport.totalPercentage}%` : undefined,
      content: (
        <CoveragePanel
          report={coverage.coverageReport}
          coverageEnabled={coverage.coverageOverlayEnabled}
          onToggleCoverage={() => coverage.setCoverageOverlayEnabled((prev) => !prev)}
          onOpenFile={(path, line) => {
            const ref = projectDiagnostics.problemPathToRef(path);
            if (ref) {
              const targetLine = line && line > 0 ? line - 1 : 0;
              const range = { start: { line: targetLine, character: 0 }, end: { line: targetLine, character: 0 } };
              void openFile(ref).then(() => librarySources.revealEditorLocation(fileKey(ref), range));
            }
          }}
          onRefreshCoverage={() => void coverage.scanWorkspaceCoverage()}
        />
      ),
    },
    {
      // ED-PARITY-018 DEC-018-01: the workspace Git tool window hosts the
      // same Git manager as the Git tab, scoped to this workspace's repos.
      id: "git",
      label: "Git",
      icon: <GitBranch className="h-3.5 w-3.5" />,
      // Mounted on first open and kept, so the commit message and
      // selection survive hiding the tool window.
      content: gitSnapshotOwner.gitRoots.length > 0 && (gitToolWindowMounted || (bottomDockOpen && bottomDockTab === "git")) ? (
        <div data-testid="code-workspace-git-tool-window" tabIndex={-1} className="relative h-full min-h-0 outline-none">
          <WorkspaceGitManager
            workspaceName={title}
            roots={gitSnapshotOwner.gitRoots}
            activeRepoRoot={activeGitRoot?.repoRoot ?? gitSnapshotOwner.gitRoots[0]?.repoRoot ?? null}
            visible={bottomDockOpen && bottomDockTab === "git"}
          />
        </div>
      ) : (
        <div data-testid="code-workspace-git-tool-window-empty" role="status" className="px-3 py-3 text-[11px] text-[var(--taomni-code-muted)]">
          {gitSnapshotOwner.gitRootsLoading ? "Detecting Git repositories…" : "No Git repository in this workspace"}
        </div>
      ),
    },
    {
      id: "debug",
      label: "Debug",
      icon: <Bug className="h-3.5 w-3.5" />,
      content: (
        <DebugPanel
          debug={debug}
          onStart={activeFileDebuggable ? debugLaunch.startDebugActiveTarget : null}
          onAttach={activeFileJavaRoot && debugRuntimeAvailable ? debugEntryPoints.attachRemoteDebug : null}
          onOpenFrame={openDebugFrame}
          onOpenBreakpoint={(path, line, column) => openDebugFrame({ path, line, column })}
          onOpenLocation={(path, line, column) => openDebugFrame({ path, line, column })}
          editingBreakpoint={breakpoints.editingBreakpoint}
          onEditingBreakpointChange={breakpoints.setEditingBreakpoint}
          onViewBreakpoints={() => breakpoints.setBreakpointsDialog({ initial: null })}
          onEvaluateExpression={(expression) => openEvaluateDialogRef.current(expression ?? "")}
          onRunToCursor={debug.state?.status === "stopped" && breakpoints.activeFileAbsPath ? () => {
            const cursor = telemetry.cursorPositionsRef.current[activeEditorGroupId];
            const line = (cursor?.line ?? editorSelectionRef.current.start.line) + 1;
            breakpoints.debugRunToCursorLine(line);
          } : null}
          runtimeAvailable={debugRuntimeAvailable}
          configurations={execution.activeRunConfigurations
            .filter((configuration) => configuration.kind !== "module")
            .map((configuration) => {
              const detectedDebug = configuration.debugConfigurationId
                ? execution.activeExecutionModel?.debugConfigurations.find((candidate) => (
                  candidate.id === configuration.debugConfigurationId
                ))
                : undefined;
              const rootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : undefined;
              const override = readRunConfigurationOverrides(workspaceInstanceId, rootId)[configuration.id];
              const debugConfiguration = detectedDebug
                ? applyRunOverrideToDebugConfiguration(
                  detectedDebug,
                  override,
                  configuration.runtimeOptions,
                  configuration.envFile,
                )
                : undefined;
              const canUseJavaCompatibilityDebug = activeFileJavaRoot
                && !configuration.debugConfigurationId
                && configuration.kind !== "debug-only";
              const available = debugRuntimeAvailable
                && (debugConfiguration
                  ? debugConfiguration.available === true
                  : canUseJavaCompatibilityDebug);
              const diagnostic = !debugRuntimeAvailable
                ? "Debugging is available in the desktop app only"
                : debugConfiguration?.diagnostic
                ?? (!debugConfiguration && canUseJavaCompatibilityDebug
                  ? undefined
                  : "No available debug configuration is associated with this run target");
              return {
                id: configuration.id,
                label: configuration.label,
                source: configuration.configurationSource,
                available,
                diagnostic: available ? undefined : diagnostic,
              };
            })}
          activeConfigurationId={execution.activeRunConfiguration?.id ?? null}
          workspaceInstanceId={workspaceInstanceId}
          onActiveConfigurationChange={(configurationId) => {
            if (!activeFile) return;
            const sourceFile = absolutePathForOpenFile(activeFile);
            if (sourceFile) writeActiveRunConfigurationSelection(
              workspaceInstanceId,
              sourceFile,
              configurationId,
            );
          }}
        />
      ),
    },
  ];
  return { bottomDockTabs };
}
