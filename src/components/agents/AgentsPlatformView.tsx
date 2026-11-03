import { FileText, Menu, PanelRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentIntent } from "../../lib/ipc/orchestration";
import { useOrchestrationStore } from "../../stores/orchestrationStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { WorkspaceFsModals } from "../workspace/WorkspaceFsModals";
import { AgentComposer } from "./orchestration/AgentComposer";
import { AgentConversation } from "./orchestration/AgentConversation";
import { AgentTaskSidebar } from "./orchestration/AgentTaskSidebar";
import { RecoveryPrompt } from "./orchestration/RecoveryPrompt";
import { SharedAgentSettings } from "./orchestration/SharedAgentSettings";
import { TaskInspector, type InspectorTab } from "./orchestration/TaskInspector";
import { useOrchT } from "./orchestration/locales";
import { useOrchestrationRuntime } from "./orchestration/useOrchestrationRuntime";
import "../../styles/orchestration.css";

const ROOT_REQUEST = { kind: "root" as const, directory: "" };

/** Composition only; durable runs/settings and async guards belong to their owners. */
export function AgentsPlatformView() {
  const t = useOrchT();
  const workspace = useWorkspacePlatformStore((state) =>
    state.workspaces.find((entry) => entry.id === state.activeWorkspaceId),
  );
  const state = useOrchestrationStore();
  const [rootChoice, setRootChoice] = useState<{ workspaceId: string; path: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectDialogWorkspaceId, setProjectDialogWorkspaceId] = useState<string | null>(null);
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<InspectorTab | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [intent, setIntent] = useState<AgentIntent>("develop");
  const [paths, setPaths] = useState<string[]>([]);
  const roots = workspace?.rootFolders ?? [];
  const projectPath = rootChoice
    && rootChoice.workspaceId === workspace?.id
    && roots.some((root) => root.path === rootChoice.path)
    ? rootChoice.path
    : roots.find((root) => root.path === state.projectPath)?.path ?? roots[0]?.path ?? "";
  const projectName = roots.find((root) => root.path === projectPath)?.name ?? "";
  // Gate the old selection during the render before the project-sync effect.
  const run = state.projectPath === projectPath
    ? state.runs.find((entry) => entry.id === state.selectedRunId && entry.projectPath === projectPath) ?? null
    : null;
  const recoveryRun = state.runs.find((entry) =>
    entry.id === recoveryId && entry.projectPath === projectPath && entry.status === "partial",
  );

  useEffect(() => {
    useOrchestrationStore.getState().setProject(projectPath);
    setGoal("");
    setPaths([]);
    setInspector(null);
    setRecoveryId(null);
  }, [projectPath]);
  useOrchestrationRuntime();

  const select = (id: string | null) => {
    state.selectRun(id);
    setGoal("");
    setPaths([]);
    setInspector(null);
    setRecoveryId(null);
  };
  const chooseProject = (path: string) => {
    if (workspace) setRootChoice({ workspaceId: workspace.id, path });
  };
  const submit = async () => {
    const submittedGoal = goal;
    const submittedProject = projectPath;
    const created = await useOrchestrationStore.getState().submit({
      projectPath, goal, intent, sourcePaths: paths,
    });
    if (created && useOrchestrationStore.getState().projectPath === submittedProject) {
      setGoal((current) => current === submittedGoal ? "" : current);
      setPaths([]);
    }
  };

  return (
    <div
      data-testid="agents-platform-view"
      className={`orch-root orch-workbench ${run ? "has-conversation" : ""} ${inspector ? "has-inspector" : ""}`}
    >
      {sidebarOpen && (
        <AgentTaskSidebar
          workspace={workspace}
          projectPath={projectPath}
          runs={state.runs}
          selectedId={run?.id ?? null}
          settings={state.settings}
          onProject={chooseProject}
          onSelect={select}
          onSettings={() => setSettingsOpen(true)}
        />
      )}
      <main className="orch-agent-main" data-testid="orch-workspace">
        <header className="orch-conversation-header">
          <button
            type="button"
            data-testid="orch-sidebar-toggle"
            className="orch-icon-button"
            aria-label={t("toggleSidebar")}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Menu />
          </button>
          <strong data-testid="orch-title">{run?.title ?? t("newTask")}</strong>
          <span className="orch-header-context" title={projectPath}>{projectName || t("noProject")}</span>
          <span className="orch-fill" />
          <button
            type="button"
            data-testid="orch-refresh"
            className="orch-icon-button"
            aria-label={t("refresh")}
            disabled={state.loading}
            onClick={() => { void state.load(); }}
          >
            <RefreshCw className={state.loading ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            data-testid="orch-show-sources"
            className="orch-header-tool"
            onClick={() => setInspector(inspector === "sources" ? null : "sources")}
          >
            <FileText /><span>{t("context")}</span>
          </button>
          <button
            type="button"
            data-testid="orch-show-changes"
            className="orch-header-tool"
            onClick={() => setInspector(inspector === "changes" ? null : "changes")}
          >
            <PanelRight /><span>{t("changes")}</span>
          </button>
        </header>
        {state.error && (
          <div data-testid="orch-error" role="alert" className="orch-error-banner">
            <span>{state.error}</span>
            <button type="button" className="orch-quiet" onClick={() => { void state.load(); }}>{t("retry")}</button>
            <button type="button" className="orch-quiet" onClick={state.clearError}>{t("close")}</button>
          </div>
        )}
        <div className="orch-conversation-layout">
          <section className="orch-chat-surface" aria-label={t("agent")}>
            <div className="orch-chat-scroll">
              <AgentConversation
                run={run}
                projectName={projectName}
                pending={!!state.pending}
                onSuggestion={(text, mode) => { select(null); setGoal(text); setIntent(mode); }}
                onStart={() => { if (run) void state.start(run.id).catch(() => {}); }}
                onStop={() => { if (run) void state.cancel(run.id).catch(() => {}); }}
                onRecover={() => { if (run) setRecoveryId(run.id); }}
                onArtifact={(id) => { setArtifactId(id); setInspector("changes"); }}
                onContext={() => setInspector("sources")}
              />
            </div>
            <AgentComposer
              roots={roots}
              projectPath={projectPath}
              goal={goal}
              intent={intent}
              paths={paths}
              settings={state.settings}
              pending={!!state.pending}
              onProject={chooseProject}
              onGoal={setGoal}
              onIntent={setIntent}
              onPaths={setPaths}
              onSubmit={() => { void submit(); }}
              onSettings={() => setSettingsOpen(true)}
              onContext={() => setInspector("sources")}
              onAddProject={() => { if (workspace) setProjectDialogWorkspaceId(workspace.id); }}
            />
          </section>
          {inspector && (
            <TaskInspector
              tab={inspector}
              run={run}
              projectPath={projectPath}
              paths={paths}
              artifactId={artifactId}
              onTab={setInspector}
              onClose={() => setInspector(null)}
            />
          )}
        </div>
      </main>
      <WorkspaceFsModals
        request={projectDialogWorkspaceId === workspace?.id ? ROOT_REQUEST : null}
        initialPath={projectPath || undefined}
        onCancel={() => setProjectDialogWorkspaceId(null)}
        onSubmit={(path) => {
          if (!projectDialogWorkspaceId) return;
          const root = useWorkspacePlatformStore.getState().addRootFolder(projectDialogWorkspaceId, { path });
          if (root) setRootChoice({ workspaceId: projectDialogWorkspaceId, path: root.path });
          setProjectDialogWorkspaceId(null);
        }}
      />
      {settingsOpen && <SharedAgentSettings settings={state.settings} onClose={() => setSettingsOpen(false)} />}
      {recoveryRun && <RecoveryPrompt run={recoveryRun} onClose={() => setRecoveryId(null)} />}
    </div>
  );
}
