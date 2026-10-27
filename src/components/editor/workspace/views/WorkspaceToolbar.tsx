import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Braces, GitBranch, GitCommitHorizontal, Loader2, RefreshCw, RotateCcw, Save, PanelRight, Columns2, Rows2, Play, Hammer, Bug, Search, X, ZoomIn, ZoomOut, WrapText, Columns3, Link2, AlignHorizontalJustifyCenter, Maximize2, Square, SlidersHorizontal, MoreVertical, Settings as SettingsIcon } from "lucide-react";
import { type ExecutionRunConfiguration, type ExecutionDebugConfiguration } from "../../../../lib/editor/workspace";
import { type EditorSplitOrientation, type RightPaneTabId } from "../../../../stores/codeWorkspaceStore";
import { openSettingsSection } from "../../../../lib/settingsNavigation";
import { type WorkspaceIntelligencePreferences } from "../intelligencePreferences";
import { WorkspaceSdkStatus } from "../WorkspaceSdkStatus";
import { ProjectFactsStatusBadge } from "../ProjectFactsStatusBadge";
import { DEFAULT_EDITOR_APPEARANCE_PROFILE } from "../editorAppearanceProfile";
import { writeActiveRunConfigurationSelection } from "../runConfigurationPersistence";
import { IconButton } from "../workspaceChrome";
import { type WorkspaceCommandContext } from "../workspaceCommands";
import type { CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, CODE_WORKSPACE_MAX_FONT_SIZE, CODE_WORKSPACE_MIN_FONT_SIZE } from "../codeWorkspaceModel";
import { type CodeWorkspaceGitManagerPayload } from "../controller/model";
import { useWorkspaceHost } from "../workspaceHostIntegration";
import { useT } from "../../../../lib/i18n";


export interface WorkspaceToolbarProps {
  title: string;
  roots: CodeWorkspaceRootInfo[];
  looseFiles: CodeWorkspaceLooseFileInfo[];
  dirtyCount: number;
  visible: boolean;
  workspaceWidgetHost: HTMLElement | null;
  projectFactsRoot: string;
  projectFacts: { refresh: (customOptions?: Partial<import("../../../../stores/projectFactsStore").FetchProjectFactsOptions>) => Promise<import("../../../../stores/projectFactsStore").WorkspaceProjectFactsEntry>; invalidate: (reason?: string) => void; workspaceRoot: string; generation: number; status: import("../../../../stores/projectFactsStore").ProjectFactsStatus; reason: string | null; fingerprint: string | null; structure: import("../projectStructureModel").ProjectStructureSnapshotV2 | null; provenance: import("../../../../lib/editor/workspaceTooling").MavenToolingProvenance | import("../../../../lib/editor/workspaceTooling").GradleToolingProvenance | null; isStale: boolean; abortController?: AbortController | null; };
  projectDescriptorDiscovery: import("../../../../hooks/useProjectDescriptorDiscovery").ProjectDescriptorDiscoveryState;
  refreshProjectFacts: () => void;
  gitRootsLoading: boolean;
  onOpenGitManager: ((payload: CodeWorkspaceGitManagerPayload) => void) | undefined;
  gitRoots: import("../../../../lib/editor/workspace").WorkspaceGitRoot[];
  executeWorkspaceCommand: (commandId: string, context?: WorkspaceCommandContext) => boolean;
  projectBuildBusy: boolean;
  buildActiveProject: (rebuild?: boolean) => Promise<void>;
  activeRunConfiguration: ExecutionRunConfiguration | null;
  javaRunBusy: boolean;
  activeFileRunnable: boolean;
  runActiveTarget: () => void;
  activeRunConfigurations: ExecutionRunConfiguration[];
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  workspaceInstanceId: string;
  debugRuntimeAvailable: boolean;
  activeDebugConfiguration: ExecutionDebugConfiguration | null;
  activeFileDebuggable: boolean;
  debugSessionActive: boolean;
  startDebugActiveTarget: () => void;
  toolbarMoreOpen: boolean;
  setToolbarMoreOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  navCan: { back: boolean; forward: boolean; };
  currentEditorFontSize: number;
  stepCodeViewFontSize: (delta: number) => void;
  setCodeViewFontSize: (size: number) => void;
  activeFileSoftWrap: boolean;
  toggleSoftWrap: () => void;
  columnSelectionMode: boolean;
  toggleColumnSelectionMode: () => void;
  splitOrientation: EditorSplitOrientation | null;
  splitEditor: (orientation: EditorSplitOrientation, key?: string | null, sourceGroupId?: string) => void;
  syncSplitScroll: boolean;
  setSyncSplitScroll: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setStatusMessage: (message: string) => void;
  closeSplit: () => void;
  activeInlayHintsEnabled: boolean;
  activeLanguageId: string | null;
  activeCapabilities: import("../../../../lib/editor/lsp").LspCapabilitySummary | null;
  toggleInlayHintsForActiveLanguage: () => void;
  intelligencePreferences: WorkspaceIntelligencePreferences;
  activeGitRoot: import("../../../../lib/editor/workspace").WorkspaceGitRoot | null;
  toggleInlineBlame: () => void;
  rightPaneOpen: boolean;
  rightPaneTab: RightPaneTabId;
  openTabPolicySettings: () => void;
}

export function WorkspaceToolbar(viewProps: WorkspaceToolbarProps) {
  const host = useWorkspaceHost();
  const t = useT();
  const { absolutePathForOpenFile, activeCapabilities, activeDebugConfiguration, activeFile, activeFileDebuggable, activeFileRunnable, activeFileSoftWrap, activeGitRoot, activeInlayHintsEnabled, activeLanguageId, activeRunConfiguration, activeRunConfigurations, buildActiveProject, closeSplit, columnSelectionMode, currentEditorFontSize, debugRuntimeAvailable, debugSessionActive, dirtyCount, executeWorkspaceCommand, gitRoots, gitRootsLoading, intelligencePreferences, javaRunBusy, looseFiles, navCan, onOpenGitManager, openTabPolicySettings, projectBuildBusy, projectDescriptorDiscovery, projectFacts, projectFactsRoot, refreshProjectFacts, rightPaneOpen, rightPaneTab, roots, runActiveTarget, setCodeViewFontSize, setStatusMessage, setSyncSplitScroll, setToolbarMoreOpen, splitEditor, splitOrientation, startDebugActiveTarget, stepCodeViewFontSize, syncSplitScroll, title, toggleColumnSelectionMode, toggleInlayHintsForActiveLanguage, toggleInlineBlame, toggleSoftWrap, toolbarMoreOpen, visible, workspaceInstanceId, workspaceWidgetHost } = viewProps;
 return (<header className={`${host ? "h-8 gap-1 px-2" : "h-10 gap-2 px-3"} shrink-0 flex items-center overflow-x-auto border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]`}>
        {host ? <>
          <span data-testid="workspace-editor-title" className="min-w-0 truncate font-medium" title={activeFile?.path ?? title}>
            {activeFile?.path ?? title}{activeFile?.dirty ? " ●" : ""}
          </span>
          <IconButton label={t("platform.saveFile")} testId="workspace-editor-save" icon={<Save className="h-3.5 w-3.5" />}
            disabled={!activeFile?.dirty || activeFile.loading || !!activeFile.error}
            onClick={() => executeWorkspaceCommand("workspace.save", { focus: "editor" })} />
          <IconButton label={t("platform.openInGit")} testId="editor-open-git-diff" icon={<GitBranch className="h-3.5 w-3.5" />}
            onClick={() => host.onOpenGitDiff(activeFile?.ref.kind === "root" ? activeFile.ref.path : "")} />
        </> : <>
        <Braces className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="min-w-0">
          <div className="font-semibold leading-4 truncate">Code · {title}</div>
          <div className="text-[11px] text-[var(--taomni-code-muted)] truncate max-w-[620px]">
            {roots.length ? `${roots.length} root${roots.length === 1 ? "" : "s"}` : "No project roots"}
            {looseFiles.length > 0 ? ` · ${looseFiles.length} loose file${looseFiles.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        {dirtyCount > 0 && (
          <span className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 text-[11px] bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-accent)]">
            {dirtyCount} unsaved
          </span>
        )}
        </>}
        {/* ED-PARITY-010 DEC-010-05: SDK / project-facts widgets live in the
            status bar (portal) like IDEA's status widgets. */}
        {visible && workspaceWidgetHost
          ? createPortal(<>
        <WorkspaceSdkStatus roots={roots} />
            {projectFactsRoot && (
              <ProjectFactsStatusBadge
                status={projectFacts.status}
                discoveryStatus={projectDescriptorDiscovery.status}
                discovery={projectDescriptorDiscovery.discovery}
                discoveryReason={projectDescriptorDiscovery.reason}
                reason={projectFacts.reason}
                generation={projectFacts.generation}
                isStale={projectFacts.isStale}
                onRefresh={refreshProjectFacts}
              />
            )}
          </>, workspaceWidgetHost)
          : (
            <>
        <WorkspaceSdkStatus roots={roots} />
            {projectFactsRoot && (
              <ProjectFactsStatusBadge
                status={projectFacts.status}
                discoveryStatus={projectDescriptorDiscovery.status}
                discovery={projectDescriptorDiscovery.discovery}
                discoveryReason={projectDescriptorDiscovery.reason}
                reason={projectFacts.reason}
                generation={projectFacts.generation}
                isStale={projectFacts.isStale}
                onRefresh={refreshProjectFacts}
              />
            )}
            </>
          )}
        {!host && <IconButton
          label="Open Git tab"
          testId="code-workspace-git-panel-toggle"
          icon={gitRootsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
          disabled={gitRootsLoading || !onOpenGitManager || gitRoots.length === 0}
          onClick={() => executeWorkspaceCommand("workspace.openGit")}
        />}
        <div className="flex-1" />
        <IconButton
          label="Build project (Ctrl+F9)"
          testId="code-workspace-build-project"
          icon={projectBuildBusy
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Hammer className="w-3.5 h-3.5" />}
          disabled={roots.length === 0 || projectBuildBusy}
          onClick={() => buildActiveProject(false)}
        />
        <IconButton
          label={activeRunConfiguration ? `Run ${activeRunConfiguration.label} (Shift+F10)` : "Run current target (Shift+F10)"}
          testId="code-workspace-run-target"
          icon={javaRunBusy
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Play className="w-3.5 h-3.5" />}
          disabled={!activeFileRunnable || javaRunBusy}
          onClick={runActiveTarget}
        />
        {activeRunConfigurations.length > 1 && activeFile && (() => {
          const sourceFile = absolutePathForOpenFile(activeFile);
          if (!sourceFile) return null;
          return (
            <select
              data-testid="code-workspace-active-run-configuration"
              aria-label="Active run configuration"
              title="Select active Run/Debug configuration"
              value={activeRunConfiguration?.id ?? ""}
              onChange={(event) => writeActiveRunConfigurationSelection(
                workspaceInstanceId,
                sourceFile,
                event.target.value || null,
              )}
              className="h-6 max-w-44 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
            >
              {activeRunConfigurations.map((configuration) => (
                <option key={configuration.id} value={configuration.id}>{configuration.label}</option>
              ))}
            </select>
          );
        })()}
        <IconButton
          label={
            activeFileRunnable && !debugRuntimeAvailable
              ? "Debugging requires the desktop app (run: pnpm tauri dev)"
              : activeDebugConfiguration?.diagnostic ?? "Debug current target"
          }
          testId="code-workspace-debug-target"
          icon={<Bug className="w-3.5 h-3.5" />}
          disabled={!activeFileDebuggable || debugSessionActive}
          onClick={startDebugActiveTarget}
        />
        {/* ED-PARITY-010 DEC-010-04: IDEA main toolbar keeps project, VCS, run
            and search/settings; secondary editor controls moved behind ⋮. */}
        <IconButton
          label="Search Everywhere (Double Shift)"
          testId="code-workspace-toolbar-search"
          icon={<Search className="w-3.5 h-3.5" />}
          onClick={() => executeWorkspaceCommand("workspace.searchEverywhere")}
        />
        <IconButton
          label="Settings"
          testId="code-workspace-toolbar-settings"
          icon={<SettingsIcon className="w-3.5 h-3.5" />}
          onClick={() => openSettingsSection("general")}
        />
        <div className="relative">
          <IconButton
            label="More actions"
            testId="code-workspace-toolbar-more"
            icon={<MoreVertical className="w-3.5 h-3.5" />}
            active={toolbarMoreOpen}
            onClick={() => setToolbarMoreOpen((open) => !open)}
          />
          {toolbarMoreOpen && (
            <>
              <div
                role="toolbar"
                aria-label="More editor actions"
                data-testid="code-workspace-toolbar-more-menu"
                onClick={() => setToolbarMoreOpen(false)}
                className="absolute right-0 top-8 z-50 flex w-max max-w-[420px] flex-wrap items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] p-1.5 shadow-lg"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setToolbarMoreOpen(false);
                  }
                }}
              >
        <IconButton
                  label="Back"
                  testId="code-workspace-nav-back"
                  icon={<ArrowLeft className="w-3.5 h-3.5" />}
                  disabled={!navCan.back}
                  onClick={() => executeWorkspaceCommand("workspace.navigateBack")}
                />
                <IconButton
                  label="Forward"
                  testId="code-workspace-nav-forward"
                  icon={<ArrowRight className="w-3.5 h-3.5" />}
                  disabled={!navCan.forward}
                  onClick={() => executeWorkspaceCommand("workspace.navigateForward")}
                />
                <div className="flex items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1">
                  <IconButton
                    label="Editor zoom out"
                    testId="code-workspace-zoom-out"
                    icon={<ZoomOut className="w-3.5 h-3.5" />}
                    disabled={currentEditorFontSize <= CODE_WORKSPACE_MIN_FONT_SIZE}
                    onClick={() => stepCodeViewFontSize(-1)}
                  />
                  <button
                    type="button"
                    data-testid="code-workspace-zoom-reset"
                    title="Reset editor zoom"
                    aria-label="Reset editor zoom"
                    className="h-6 min-w-10 rounded px-1.5 text-[11px] tabular-nums text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                    onClick={() => setCodeViewFontSize(DEFAULT_EDITOR_APPEARANCE_PROFILE.fontSizePx)}
                  >
                    {currentEditorFontSize}px
                  </button>
                  <IconButton
                    label="Editor zoom in"
                    testId="code-workspace-zoom-in"
                    icon={<ZoomIn className="w-3.5 h-3.5" />}
                    disabled={currentEditorFontSize >= CODE_WORKSPACE_MAX_FONT_SIZE}
                    onClick={() => stepCodeViewFontSize(1)}
                  />
                </div>
                <IconButton
                  label={activeFileSoftWrap ? "Disable soft wrap" : "Enable soft wrap"}
                  testId="code-workspace-soft-wrap"
                  active={activeFileSoftWrap}
                  icon={<WrapText className="w-3.5 h-3.5" />}
                  onClick={toggleSoftWrap}
                />
                <IconButton
                  label={columnSelectionMode ? "Disable column selection mode" : "Enable column selection mode"}
                  testId="code-workspace-column-selection"
                  active={columnSelectionMode}
                  icon={<Columns3 className="w-3.5 h-3.5" />}
                  onClick={toggleColumnSelectionMode}
                />
                <IconButton
                  label="Save"
                  icon={activeFile?.saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  disabled={!activeFile || !activeFile.dirty || activeFile.saving || activeFile.loading}
                  onClick={() => executeWorkspaceCommand("workspace.save", { focus: "editor" })}
                />
                <IconButton
                  label="Reload"
                  icon={<RotateCcw className="w-3.5 h-3.5" />}
                  disabled={!activeFile || activeFile.loading}
                  onClick={() => executeWorkspaceCommand("workspace.reload", { focus: "editor" })}
                />
                <IconButton
                  label="Refresh tree"
                  icon={<RefreshCw className="w-3.5 h-3.5" />}
                  onClick={() => executeWorkspaceCommand("workspace.refreshTree")}
                />
                <IconButton
                  label="Split editor right"
                  testId="code-workspace-split-right"
                  icon={<Columns2 className="h-3.5 w-3.5" />}
                  active={splitOrientation === "vertical"}
                  disabled={!activeFile}
                  onClick={() => splitEditor("vertical")}
                />
                <IconButton
                  label="Split editor down"
                  testId="code-workspace-split-down"
                  icon={<Rows2 className="h-3.5 w-3.5" />}
                  active={splitOrientation === "horizontal"}
                  disabled={!activeFile}
                  onClick={() => splitEditor("horizontal")}
                />
                {splitOrientation && (
                  <>
                    <IconButton
                      label={syncSplitScroll ? "Disable synchronized split scrolling" : "Enable synchronized split scrolling"}
                      testId="code-workspace-split-sync-scroll"
                      icon={<Link2 className="h-3.5 w-3.5" />}
                      active={syncSplitScroll}
                      onClick={() => {
                        setSyncSplitScroll((v) => {
                          const next = !v;
                          setStatusMessage(next ? "Synchronized split scrolling enabled" : "Synchronized split scrolling disabled");
                          return next;
                        });
                      }}
                    />
                    <IconButton
                      label="Equalize split proportions"
                      testId="code-workspace-split-equalize"
                      icon={<AlignHorizontalJustifyCenter className="h-3.5 w-3.5" />}
                      onClick={() => executeWorkspaceCommand("workspace.equalizeSplitProportions")}
                    />
                    <IconButton
                      label="Stretch active split"
                      testId="code-workspace-split-stretch"
                      icon={<Maximize2 className="h-3.5 w-3.5" />}
                      onClick={() => executeWorkspaceCommand("workspace.stretchActiveSplit")}
                    />
                    <IconButton
                      label="Unsplit all (keep tabs)"
                      testId="code-workspace-split-unsplit-all"
                      icon={<Square className="h-3.5 w-3.5" />}
                      onClick={() => executeWorkspaceCommand("workspace.unsplitAll")}
                    />
                    <IconButton
                      label="Close editor split"
                      testId="code-workspace-split-close"
                      icon={<X className="h-3.5 w-3.5" />}
                      onClick={closeSplit}
                    />
                  </>
                )}
                <IconButton
                  label={`${activeInlayHintsEnabled ? "Disable" : "Enable"} inlay hints${activeLanguageId ? ` for ${activeLanguageId}` : ""}`}
                  testId="code-workspace-inlay-hints-toggle"
                  icon={<Braces className="h-3.5 w-3.5" />}
                  active={activeInlayHintsEnabled}
                  disabled={!activeCapabilities?.inlayHint}
                  onClick={toggleInlayHintsForActiveLanguage}
                />
                <IconButton
                  label={`${intelligencePreferences.inlineBlameEnabled ? "Disable" : "Enable"} inline Git blame`}
                  testId="code-workspace-inline-blame-toggle"
                  icon={<GitCommitHorizontal className="h-3.5 w-3.5" />}
                  active={intelligencePreferences.inlineBlameEnabled}
                  disabled={!activeGitRoot}
                  onClick={toggleInlineBlame}
                />
                <IconButton
                  label="Toggle outline pane"
                  testId="code-workspace-right-pane-toggle"
                  icon={<PanelRight className="w-3.5 h-3.5" />}
                  active={rightPaneOpen && rightPaneTab === "outline"}
                  onClick={() => executeWorkspaceCommand("workspace.toggleDocumentationPane")}
                />
                <IconButton
                  label="Editor tab policy settings"
                  testId="code-workspace-tab-policy-settings"
                  icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
                  onClick={openTabPolicySettings}
                />
              </div>
            </>
          )}
        </div>
      </header>);
}
