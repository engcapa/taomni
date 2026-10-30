import { memo } from "react";
import { type CodeWorkspaceTabProps } from "./workspace/controller/model";
import { useWorkspaceActionPorts } from "./workspace/hooks/useWorkspaceActionPorts";
import { useWorkspaceCommandRouting } from "./workspace/hooks/useWorkspaceCommandRouting";
import { useWorkspaceDocumentEditing } from "./workspace/hooks/useWorkspaceDocumentEditing";
import { useWorkspaceEditingFeatures } from "./workspace/hooks/useWorkspaceEditingFeatures";
import { useWorkspaceExecutionRuntime } from "./workspace/hooks/useWorkspaceExecutionRuntime";
import { useWorkspaceFileOpening } from "./workspace/hooks/useWorkspaceFileOpening";
import { useWorkspaceIntelligenceRuntime } from "./workspace/hooks/useWorkspaceIntelligenceRuntime";
import { useWorkspaceProjectRuntime } from "./workspace/hooks/useWorkspaceProjectRuntime";
import { useWorkspaceSemanticFeatures } from "./workspace/hooks/useWorkspaceSemanticFeatures";
import { useWorkspaceSession } from "./workspace/hooks/useWorkspaceSession";
import { useWorkspaceSurfaceComposition } from "./workspace/hooks/useWorkspaceSurfaceComposition";
import { useWorkspaceSurfaceState } from "./workspace/hooks/useWorkspaceSurfaceState";
import { createWorkspaceShellProps } from "./workspace/views/createWorkspaceShellProps";
import { WorkspaceShellView } from "./workspace/views/WorkspaceShellView";
import { WorkspaceHostContext, WorkspaceHostRequestContext, useWorkspaceHostPresentation } from "./workspace/workspaceHostIntegration";
import { WorkspaceHostFilesBridge } from "./workspace/views/WorkspaceHostFilesBridge";

// Context/command publications also refresh the host chrome. They must not
// re-render the entire editor when its inputs did not change; the runtime's
// own store and context subscriptions continue to deliver real updates.
export const CodeWorkspaceTab = memo(function CodeWorkspaceTab(props: CodeWorkspaceTabProps) {
  const { hostIntegration, ...runtime } = props;
  const presentation = useWorkspaceHostPresentation(hostIntegration);
  return <WorkspaceHostRequestContext.Provider value={hostIntegration ?? null}>
    <WorkspaceHostContext.Provider value={presentation}>
      <CodeWorkspaceRuntime {...runtime} />
    </WorkspaceHostContext.Provider>
  </WorkspaceHostRequestContext.Provider>;
});

const CodeWorkspaceRuntime = memo(function CodeWorkspaceRuntime({
  tabId,
  workspace,
  visible = true,
  onOpenGitManager,
  onSyncGitManager,
  onCommandsChange,
}: Omit<CodeWorkspaceTabProps, "hostIntegration">) {
  const session = useWorkspaceSession({
    workspace,
    tabId,
    visible,
  });
  const ports = useWorkspaceActionPorts();
  const surfaceState = useWorkspaceSurfaceState({
    session,
  });
  const project = useWorkspaceProjectRuntime({
    session,
    surfaceState,
    workspace,
    visible,
    ports,
  });
  const files = useWorkspaceFileOpening({
    project,
    session,
    visible,
    surfaceState,
    get keyboard() { return commands.keyboard; },
    ports,
    workspace,
  });
  const editing = useWorkspaceDocumentEditing({
    session,
    project,
    files,
    surfaceState,
    ports,
    get codeActions() { return semantics.codeActions; },
    get keyboard() { return commands.keyboard; },
    visible,
  });
  const semantics = useWorkspaceSemanticFeatures({
    session,
    editing,
    project,
    workspace,
    onOpenGitManager,
    surfaceState,
    visible,
    tabId,
    files,
    get refactoring() { return insight.refactoring; },
  });
  const editorFeatures = useWorkspaceEditingFeatures({
    editing,
    project,
    session,
    surfaceState,
    files,
    semantics,
    get refactoring() { return insight.refactoring; },
  });
  const commands = useWorkspaceCommandRouting({
    session,
    project,
    semantics,
    surfaceState,
    files,
    editorFeatures,
    editing,
    ports,
    get semanticNavigation() { return insight.semanticNavigation; },
    onOpenGitManager,
    visible,
    onCommandsChange,
    tabId,
  });
  const insight = useWorkspaceIntelligenceRuntime({
    session,
    project,
    editing,
    ports,
    semantics,
    files,
    surfaceState,
    editorFeatures,
    commands,
  });
  const executionRuntime = useWorkspaceExecutionRuntime({
    editing,
    session,
    project,
    ports,
    insight,
    files,
    semantics,
    surfaceState,
    onSyncGitManager,
    tabId,
    workspace,
  });
  const surfaces = useWorkspaceSurfaceComposition({
    session,
    editing,
    project,
    editorFeatures,
    semantics,
    commands,
    surfaceState,
    files,
    insight,
    ports,
    executionRuntime,
    visible,
  });
  const shell = createWorkspaceShellProps({
    editing,
    insight,
    semantics,
    project,
    surfaceState,
    session,
    commands,
    editorFeatures,
    files,
    executionRuntime,
    surfaces,
    visible,
    onOpenGitManager,
  });
  return <>
    <WorkspaceHostFilesBridge key={session.workspaceInstanceId} session={session} project={project} files={files} editing={editing} />
    <WorkspaceShellView {...shell.shellProps} />
  </>;
});

export { debugCurrentLineForFile,extractContextSnippet,isDeclarationDefinitionEquivalentLanguage,type CodeWorkspaceGitManagerPayload } from "./workspace/controller/model";
