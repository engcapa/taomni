import { useCallback, useEffect, useState } from "react";
import type { ExecutionBuildTarget } from "../../../../../lib/editor/workspace";
import { workspaceDetectTasks, workspaceExecutionModel, workspaceJavaRunTargets, workspaceReadLooseFile } from "../../../../../lib/editor/workspace";
import { executeTaskPlan, resolveBuildTargetPlan } from "../../executionPlan";
import {
  formatEnvironmentLines,
  javaRunTargetToExecutionRunConfiguration,
  materializeRunConfigurations,
  parseDotEnv,
  readActiveRunConfigurationSelections,
  readRunConfigurationOverrides,
  resolveEnvironmentFilePath,
  writeActiveRunConfigurationSelection,
  writeRunConfigurationOverride,
} from "../../runConfigurationPersistence";
import { type WorkspaceTaskItem } from "./model";
import { customTasksKey, readCustomTasks, taskForExecutionConfiguration } from "./tasks";

export interface UseRunPanelConfigurationsContext {
  workspaceInstanceId: string;
  roots: import("../../../../../types").CodeWorkspaceRootInfo[];
  onRun: (task: WorkspaceTaskItem, onExit: (exitCode: number) => void) => void;
  toolConfig: import("../../../../../lib/editor/workspace").WorkspaceToolConfig | undefined;
  active: boolean;
}

export function useRunPanelConfigurations(context: UseRunPanelConfigurationsContext) {
  const { workspaceInstanceId, roots, onRun, toolConfig, active } = context;
  const [detectedTasks, setDetectedTasks] = useState<WorkspaceTaskItem[]>([]);
  const [runConfigurations, setRunConfigurations] = useState<WorkspaceTaskItem[]>([]);
  const [customTasks, setCustomTasks] = useState<WorkspaceTaskItem[]>(
    () => readCustomTasks(workspaceInstanceId),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [customCommand, setCustomCommand] = useState("");
  const [customRootId, setCustomRootId] = useState(roots[0]?.id ?? "");
  const [editingConfiguration, setEditingConfiguration] = useState<{
    rootId: string;
    configurationId: string;
  } | null>(null);
  const [configurationDraft, setConfigurationDraft] = useState({
    name: "",
    cwd: "",
    args: "",
    vmOptions: "",
    env: "",
    envFile: "",
    preLaunchTargets: "",
    activeProfiles: "",
    properties: "",
  });
  const [buildTargetsByRoot, setBuildTargetsByRoot] = useState<Record<string, ExecutionBuildTarget[]>>({});
  const [executionDiagnostics, setExecutionDiagnostics] = useState<Record<string, string[]>>({});

  const openConfigurationEditor = useCallback((task: WorkspaceTaskItem) => {
    const override = readRunConfigurationOverrides(workspaceInstanceId, task.rootId)[task.id];
    setEditingConfiguration({ rootId: task.rootId, configurationId: task.id });
    setConfigurationDraft({
      name: override?.name ?? task.label,
      cwd: override?.cwd ?? "",
      args: override?.args.join("\n") ?? "",
      vmOptions: (override?.vmOptions ?? task.runConfiguration?.runtimeOptions ?? []).join("\n"),
      env: formatEnvironmentLines(override?.env ?? {}),
      envFile: override?.envFile ?? task.runConfiguration?.envFile ?? "",
      preLaunchTargets: (override?.preLaunchTargets ?? task.runConfiguration?.preLaunchTargets ?? []).join("\n"),
      activeProfiles: (override?.activeProfiles ?? []).join(", "),
      properties: Object.entries(override?.properties ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
    });
  }, [workspaceInstanceId]);

  const configuredTask = useCallback(async (task: WorkspaceTaskItem): Promise<WorkspaceTaskItem> => {
    const envFile = task.runConfiguration?.envFile?.trim();
    if (!envFile) return task;
    const path = resolveEnvironmentFilePath(task.cwd, envFile);
    const file = await workspaceReadLooseFile(path, 1024 * 1024);
    const fromFile = parseDotEnv(file.text);
    return {
      ...task,
      environment: {
        ...Object.fromEntries(Object.entries(fromFile).map(([name, value]) => [
          name,
          { value, mode: "replace" as const },
        ])),
        ...(task.environment ?? {}),
      },
    };
  }, []);

  const runBeforeLaunch = useCallback(async (task: WorkspaceTaskItem): Promise<number> => {
    const targetIds = task.runConfiguration?.preLaunchTargets ?? [];
    if (targetIds.length === 0) return 0;
    const targets = task.buildTargets ?? buildTargetsByRoot[task.rootId] ?? [];
    const resolved = resolveBuildTargetPlan(targetIds, targets);
    const plan = resolved.map((target): WorkspaceTaskItem => ({
      id: target.id,
      label: target.label,
      command: target.command.display,
      cwd: target.command.cwd,
      source: "Before launch",
      rootId: task.rootId,
      rootName: task.rootName,
      execution: {
        executable: target.command.executable,
        args: target.command.args,
        source: target.command.source as "wrapper" | "configured" | "path",
        error: target.command.error,
      },
      environment: Object.fromEntries(Object.entries(target.command.env).map(([name, value]) => [
        name,
        { value, mode: "replace" as const },
      ])),
    }));
    const result = await executeTaskPlan(plan, (next, done) => onRun(next, done));
    return result.exitCode;
  }, [buildTargetsByRoot, onRun]);

  const runSingleTask = useCallback(async (task: WorkspaceTaskItem): Promise<number> => {
    const beforeLaunchExit = await runBeforeLaunch(task);
    if (beforeLaunchExit !== 0) return beforeLaunchExit;
    const launchTask = await configuredTask(task);
    const result = await executeTaskPlan([launchTask], (next, done) => onRun(next, done));
    return result.exitCode;
  }, [configuredTask, onRun, runBeforeLaunch]);

  const refresh = useCallback(async () => {
    if (roots.length === 0) {
      setDetectedTasks([]);
      setRunConfigurations([]);
      setBuildTargetsByRoot({});
      setExecutionDiagnostics({});
      setLoaded(true);
      return;
    }
    setLoading(true);
    setError(null);
    setExecutionDiagnostics({});
    try {
      const groups = await Promise.all(roots.map(async (root) => {
        const overrides = readRunConfigurationOverrides(workspaceInstanceId, root.id);
        const [tasks, javaTargets, executionModel] = await Promise.all([
          workspaceDetectTasks(root.path, toolConfig),
          workspaceJavaRunTargets(root.path, toolConfig),
          workspaceExecutionModel(root.path, undefined, toolConfig),
        ]);
        const detected = tasks.map((task): WorkspaceTaskItem => ({
          ...task,
          rootId: root.id,
          rootName: root.name,
        }));
        const projectById = new Map(executionModel.projects.map((project) => [project.id, project]));
        const javaConfigurations = javaTargets.map(javaRunTargetToExecutionRunConfiguration);
        const javaSourceFiles = new Set(javaConfigurations.flatMap((configuration) => (
          configuration.sourceFile ? [configuration.sourceFile.replace(/\\/g, "/")] : []
        )));
        const discoveredConfigurations = [
          ...executionModel.runConfigurations.filter((configuration) => (
            configuration.configurationSource === "shared"
            || !configuration.sourceFile
            || !javaSourceFiles.has(configuration.sourceFile.replace(/\\/g, "/"))
          )),
          ...javaConfigurations,
        ];
        const defaultsById = new Map(discoveredConfigurations.map((configuration) => [
          configuration.id,
          configuration,
        ]));
        const configurations = materializeRunConfigurations(
          discoveredConfigurations,
          overrides,
        ).map((configuration): WorkspaceTaskItem => {
          const project = projectById.get(configuration.projectId);
          return taskForExecutionConfiguration(
            configuration,
            root,
            project ? `${project.languages.join("/")} · ${project.provider}` : "Run configuration",
            executionModel.buildTargets,
            defaultsById.get(configuration.baseConfigurationId ?? configuration.id),
          );
        });
        return {
          tasks: detected,
          configurations,
          buildTargets: executionModel.buildTargets,
          diagnostics: executionModel.diagnostics ?? [],
        };
      }));
      setDetectedTasks(groups.flatMap((group) => group.tasks));
      setRunConfigurations(groups.flatMap((group) => group.configurations));
      setBuildTargetsByRoot(Object.fromEntries(roots.map((root, index) => [
        root.id,
        groups[index]?.buildTargets ?? [],
      ])));
      setExecutionDiagnostics(Object.fromEntries(roots.map((root, index) => [
        root.id,
        groups[index]?.diagnostics ?? [],
      ])));
      setLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [roots, toolConfig, workspaceInstanceId]);

  const deleteNamedConfiguration = useCallback((configuration: WorkspaceTaskItem) => {
    const override = readRunConfigurationOverrides(workspaceInstanceId, configuration.rootId)[configuration.id];
    if (!override?.baseConfigurationId) return;
    writeRunConfigurationOverride(workspaceInstanceId, configuration.id, null, configuration.rootId);
    const selections = readActiveRunConfigurationSelections(workspaceInstanceId);
    for (const [sourceFile, selectedId] of Object.entries(selections)) {
      if (selectedId === configuration.id) {
        writeActiveRunConfigurationSelection(
          workspaceInstanceId,
          sourceFile,
          override.baseConfigurationId,
        );
      }
    }
    setEditingConfiguration(null);
    void refresh();
  }, [refresh, workspaceInstanceId]);

  useEffect(() => {
    if (active && !loaded && !loading) void refresh();
  }, [active, loaded, loading, refresh]);

  // Re-detect when the tool config changes so wrapper/executable resolution and
  // any "tool not found" diagnostics reflect the new settings immediately.
  useEffect(() => {
    if (active && loaded) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolConfig]);

  useEffect(() => {
    window.localStorage.setItem(customTasksKey(workspaceInstanceId), JSON.stringify(customTasks));
  }, [customTasks, workspaceInstanceId]);
  return { detectedTasks, customTasks, buildTargetsByRoot, runConfigurations, runBeforeLaunch, configuredTask, runSingleTask, refresh, setCustomTasks, setEditingConfiguration, setConfigurationDraft, openConfigurationEditor, customCommand, customRootId, setCustomCommand, setCustomRootId, loading, error, executionDiagnostics, editingConfiguration, deleteNamedConfiguration, configurationDraft };
}
