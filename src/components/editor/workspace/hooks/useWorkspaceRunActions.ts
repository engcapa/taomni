import { useCallback } from "react";
import { workspaceReadLooseFile,workspaceJavaRunTarget,type ExecutionRunConfiguration,type ExecutionBuildTarget,type WorkspaceToolConfig } from "../../../../lib/editor/workspace";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import {
  applyRunConfigurationOverride,
  javaRunTargetToExecutionRunConfiguration,
  materializeRunConfigurations,
  parseDotEnv,
  readRunConfigurationOverrides,
  resolveEnvironmentFilePath,
} from "../runConfigurationPersistence";
import { executeTaskPlan,resolveBuildTargetPlan } from "../executionPlan";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState,errorMessage } from "../codeWorkspaceModel";
import { type RunPanelHandle,type WorkspaceTaskItem } from "../panels/RunPanel";
import { createBuildActiveProject } from "../controller/runActions";


export interface UseWorkspaceRunActionsContext {
  runPanelRef: import("react").RefObject<RunPanelHandle|null>;
  runWorkspaceTask: (task: WorkspaceTaskItem,onExit?: (exitCode: number) => void) => void;
  workspaceInstanceId: string;
  activeExecutionModel: import("../../../../lib/editor/workspace").WorkspaceExecutionModel|null;
  runConfigurationRevision: number;
  javaRunBusy: boolean;
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  activeKey: string|null;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo|null;
  setJavaRunBusy: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  saveOpenBufferText: (key: string,textToSave?: string,saveOptions?: { eol?: import("../editorGroupTypes").OpenFileEol|"lf"|"crlf"|"cr"; encoding?: string; bom?: boolean; },onCommitResult?: (result: import("../saveCommit").SaveCommitResult) => void) => Promise<import("../../../../lib/editor/workspace").WorkspaceFile|null>;
  toolConfigRef: import("react").RefObject<WorkspaceToolConfig|undefined>;
  setStatusMessage: (message: string) => void;
  setBottomDockTab: (tab: BottomDockTabId|((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean|((prev: boolean) => boolean)) => void;
  activeRunConfiguration: ExecutionRunConfiguration|null;
  activeFileIsJava: boolean;
  projectBuildBusy: boolean;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  setProjectBuildBusy: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  absolutePathForOpenFile: (file: OpenFileState) => string|null;
  saveFile: (key?: string|null) => Promise<void>;
  runActiveJavaFileRef: import("react").RefObject<() => void>;
  buildActiveProjectRef: import("react").RefObject<(rebuild?: boolean) => void>;
  recompileActiveFileRef: import("react").RefObject<() => void>;
}

export function useWorkspaceRunActions(context: UseWorkspaceRunActionsContext) {
  const {
    runPanelRef,
    runWorkspaceTask,
    workspaceInstanceId,
    activeExecutionModel,
    runConfigurationRevision,
    javaRunBusy,
    openFilesRef,
    activeKey,
    findRoot,
    setJavaRunBusy,
    saveOpenBufferText,
    toolConfigRef,
    setStatusMessage,
    setBottomDockTab,
    setBottomDockOpen,
    activeRunConfiguration,
    activeFileIsJava,
    projectBuildBusy,
    rootsRef,
    setProjectBuildBusy,
    absolutePathForOpenFile,
    saveFile,
    runActiveJavaFileRef,
    buildActiveProjectRef,
    recompileActiveFileRef,
  }=context;

  const launchWorkspaceTask=useCallback((task: WorkspaceTaskItem,onExit?: (exitCode: number) => void) => {
    if(runPanelRef.current) {
      runPanelRef.current.run(task,onExit);
    } else {
      runWorkspaceTask(task,onExit);
    }
  },[runWorkspaceTask]);

  const runTaskAndWait=useCallback(async (task: WorkspaceTaskItem): Promise<void> => {
    const result=await executeTaskPlan([task],(next,onExit) => launchWorkspaceTask(next,onExit));
    if(result.exitCode!==0) {
      throw new Error(`${result.failed?.label??task.label} exited with ${result.exitCode}`);
    }
  },[launchWorkspaceTask]);

  const taskForRunConfiguration=useCallback((
    configuration: ExecutionRunConfiguration,
    root: CodeWorkspaceRootInfo,
    source: string,
  ): WorkspaceTaskItem => {
    const overrides=readRunConfigurationOverrides(workspaceInstanceId,root.id);
    return {
      id: configuration.id,
      label: configuration.label,
      command: configuration.command.display,
      cwd: configuration.command.cwd,
      source,
      rootId: root.id,
      rootName: root.name,
      configuration: true,
      runConfiguration: configuration,
      execution: {
        executable: configuration.command.executable,
        args: configuration.command.args,
        source: configuration.command.source,
        error: configuration.command.error,
      },
      environment: Object.fromEntries(Object.entries(configuration.command.env).map(([name,value]) => [
        name,
        { value,mode: configuration.environmentModes?.[name]??"replace" },
      ])),
      dependsOn: configuration.preLaunchTargets,
      buildTargets: activeExecutionModel?.buildTargets,
      configurationCatalog: activeExecutionModel
        ? materializeRunConfigurations(activeExecutionModel.runConfigurations,overrides)
        :undefined,
    };
  },[activeExecutionModel,runConfigurationRevision,workspaceInstanceId]);

  const executeBeforeLaunch=useCallback(async (
    targetIds: readonly string[],
    targets: readonly ExecutionBuildTarget[],
    root: CodeWorkspaceRootInfo,
  ): Promise<void> => {
    if(targetIds.length===0) return;
    const plan=resolveBuildTargetPlan(targetIds,targets);
    const tasks=plan.map((target): WorkspaceTaskItem => ({
      id: target.id,
      label: target.label,
      command: target.command.display,
      cwd: target.command.cwd,
      source: "Before launch",
      rootId: root.id,
      rootName: root.name,
      execution: {
        executable: target.command.executable,
        args: target.command.args,
        source: target.command.source,
        error: target.command.error,
      },
      environment: Object.fromEntries(Object.entries(target.command.env).map(([name,value]) => [
        name,
        { value,mode: "replace" as const },
      ])),
    }));
    const result=await executeTaskPlan(tasks,(task,onExit) => runWorkspaceTask(task,onExit));
    if(result.exitCode!==0) {
      throw new Error(`Before launch failed: ${result.failed?.label??"build target"} exited with ${result.exitCode}`);
    }
  },[runWorkspaceTask]);

  const readEnvironmentFile=useCallback(async (
    cwd: string,
    envFile: string|undefined,
  ): Promise<Record<string,string>> => {
    if(!envFile?.trim()) return {};
    const path=resolveEnvironmentFilePath(cwd,envFile);
    const file=await workspaceReadLooseFile(path,1024*1024);
    return parseDotEnv(file.text);
  },[]);

  /** Compatibility fallback for a Java source file without a structured provider configuration. */
  const runActiveJavaFile=useCallback(() => {
    if(javaRunBusy) return;
    void (async () => {
      const file=openFilesRef.current[activeKey??""];
      if(!file||file.ref.kind!=="root"||file.library) return;
      const root=findRoot(file.ref.rootId);
      if(!root) return;
      setJavaRunBusy(true);
      try {
        // Java launch discovery intentionally reads the on-disk source so a
        // dirty new main method must be persisted before resolving it.
        if(file.dirty) {
          await saveOpenBufferText(file.key,file.text);
        }
        const detected=javaRunTargetToExecutionRunConfiguration(
          await workspaceJavaRunTarget(root.path,file.ref.path,toolConfigRef.current),
        );
        const override=readRunConfigurationOverrides(workspaceInstanceId,root.id)[detected.id];
        const configuration=applyRunConfigurationOverride(detected,override);
        const task=taskForRunConfiguration(configuration,root,"Java · compatibility");
        await runTaskAndWait(task);
        setStatusMessage(`Running ${configuration.label}`);
      } catch(error) {
        setStatusMessage(errorMessage(error));
        setBottomDockTab("run");
        setBottomDockOpen(true);
      } finally {
        setJavaRunBusy(false);
      }
    })();
  },[
    activeKey,
    findRoot,
    javaRunBusy,
    runTaskAndWait,
    saveOpenBufferText,
    taskForRunConfiguration,
    workspaceInstanceId,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
  ]);

  const runActiveTarget=useCallback(() => {
    if(activeRunConfiguration?.kind==="debug-only"||activeRunConfiguration?.command.error) {
      setStatusMessage(
        activeRunConfiguration.command.error
        ??`${activeRunConfiguration.label} cannot be started with Run`,
      );
      return;
    }
    if(activeFileIsJava&&!activeRunConfiguration) {
      runActiveJavaFile();
      return;
    }
    if(javaRunBusy||!activeRunConfiguration) return;
    void (async () => {
      const file=openFilesRef.current[activeKey??""];
      if(!file||file.ref.kind!=="root"||file.library) return;
      const root=findRoot(file.ref.rootId);
      if(!root) return;
      setJavaRunBusy(true);
      try {
        if(file.dirty) await saveOpenBufferText(file.key,file.text);
        const project=activeExecutionModel?.projects.find((item) => item.id===activeRunConfiguration.projectId);
        await runTaskAndWait(taskForRunConfiguration(
          activeRunConfiguration,
          root,
          project? `${project.languages.join("/")} · ${project.provider}`:"Run configuration",
        ));
        setStatusMessage(`Running ${activeRunConfiguration.label}`);
      } catch(error) {
        setStatusMessage(errorMessage(error));
        setBottomDockTab("run");
        setBottomDockOpen(true);
      } finally {
        setJavaRunBusy(false);
      }
    })();
  },[
    activeExecutionModel,
    activeFileIsJava,
    activeKey,
    activeRunConfiguration,
    findRoot,
    javaRunBusy,
    runActiveJavaFile,
    runTaskAndWait,
    taskForRunConfiguration,
    saveOpenBufferText,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
  ]);

  /** IDEA-style Ctrl+F9: compile the active root using its real build tool. */
  const buildActiveProject=useCallback(createBuildActiveProject({
    projectBuildBusy,
    openFilesRef,
    activeKey,
    findRoot,
    rootsRef,
    setProjectBuildBusy,
    absolutePathForOpenFile,
    toolConfigRef,
    launchWorkspaceTask,
    setStatusMessage,
    setBottomDockTab,
    setBottomDockOpen,
    runTaskAndWait,
  }),[
    activeKey,
    absolutePathForOpenFile,
    findRoot,
    launchWorkspaceTask,
    projectBuildBusy,
    runTaskAndWait,
    setBottomDockOpen,
    setBottomDockTab,
    setStatusMessage,
  ]);

  /** IDEA-style Ctrl+Shift+F9: Recompile active file (save if dirty, then compile target). */
  const recompileActiveFile=useCallback(async () => {
    const file=openFilesRef.current[activeKey??""];
    if(!file||file.library) return;
    if(file.dirty) {
      await saveFile();
    }
    await buildActiveProject(false);
  },[activeKey,saveFile,buildActiveProject]);

  runActiveJavaFileRef.current=runActiveTarget;
  buildActiveProjectRef.current=buildActiveProject;
  recompileActiveFileRef.current=recompileActiveFile;
  return { executeBeforeLaunch,readEnvironmentFile,buildActiveProject,runActiveTarget };
}
