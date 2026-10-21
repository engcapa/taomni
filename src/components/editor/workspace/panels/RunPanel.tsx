import { AlertTriangle, CopyPlus, Play, SlidersHorizontal } from "lucide-react";
import { forwardRef, useCallback, useImperativeHandle, useMemo, useState } from "react";
import { executeCompoundConfiguration, executeTaskPlan } from "../executionPlan";
import { createNamedRunConfiguration, formatEnvironmentLines, readRunConfigurationOverrides } from "../runConfigurationPersistence";
import { type RunHistoryEntry, type RunPanelHandle, type RunPanelProps, type WorkspaceTaskItem } from "./run/model";
import { RunPanelView } from "./run/RunPanelView";
import { configurationSourceLabel, taskForExecutionConfiguration } from "./run/tasks";
import { useRunPanelConfigurations } from "./run/useRunPanelConfigurations";

export const RunPanel = forwardRef<RunPanelHandle, RunPanelProps>(function RunPanel({
  workspaceInstanceId,
  roots,
  active,
  onRun,
  toolConfig,
  onConfigureTools,
}, ref) {
  const [history, setHistory] = useState<RunHistoryEntry[]>([]);
  const configurations = useRunPanelConfigurations({
    workspaceInstanceId,
    roots,
    onRun,
    toolConfig,
    active,
  });

  const tasks = useMemo(() => [...configurations.detectedTasks, ...configurations.customTasks], [configurations.customTasks, configurations.detectedTasks]);

  const runTask = useCallback((task: WorkspaceTaskItem, afterExit?: (exitCode: number) => void) => {
    const historyId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: RunHistoryEntry = {
      id: historyId,
      task,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
    };
    setHistory((current) => [entry, ...current].slice(0, 20));
    const finishHistory = (exitCode: number, message?: string) => {
      setHistory((current) => current.map((historyEntry) => historyEntry.id === historyId
        ? {
          ...historyEntry,
          status: exitCode === 0 ? "passed" : "failed",
          exitCode,
          message,
        }
        : historyEntry));
      afterExit?.(exitCode);
    };
    if (task.execution?.error) {
      finishHistory(1, task.execution.error);
      return;
    }
    const compoundIds = task.runConfiguration?.compoundConfigurationIds;
    if (task.runConfiguration?.kind === "compound" && (
      !compoundIds?.length || !!task.runConfiguration.command.error
    )) {
      finishHistory(
        1,
        task.runConfiguration.command.error ?? "Compound configuration has no valid Run children",
      );
      return;
    }
    if (compoundIds?.length) {
      const candidates = task.configurationCatalog !== undefined
        ? task.configurationCatalog.map((configuration) => taskForExecutionConfiguration(
          configuration,
          { id: task.rootId, name: task.rootName },
          "Run configuration",
          task.buildTargets ?? configurations.buildTargetsByRoot[task.rootId] ?? [],
        ))
        : configurations.runConfigurations.filter((item) => item.rootId === task.rootId);
      const configurationNodes = candidates
        .filter((item) => item.id !== task.id && item.runConfiguration)
        .map((item) => ({
          ...item.runConfiguration!,
          id: item.id,
        }));
      const rootNode = {
        ...task.runConfiguration,
        id: task.id,
      };
      const taskById = new Map(candidates.map((item) => [item.id, item]));
      const run = async () => {
        try {
          const result = await executeCompoundConfiguration(
            rootNode,
            configurationNodes,
            async (node) => {
              const candidate = node.id === task.id ? task : taskById.get(node.id);
              if (!candidate) return 1;
              return configurations.runBeforeLaunch(candidate);
            },
            async (node) => {
              const candidate = node.id === task.id ? task : taskById.get(node.id);
              if (!candidate) return 1;
              const launchTask = await configurations.configuredTask(candidate);
              const result = await executeTaskPlan([launchTask], (next, done) => onRun(next, done));
              return result.exitCode;
            },
          );
          finishHistory(result.exitCode);
        } catch (error) {
          finishHistory(1, error instanceof Error ? error.message : String(error));
        }
      };
      void run();
      return;
    }
    // Keep the common task path synchronous. This preserves the integrated
    // terminal's immediate-start behavior; only configured env files or
    // Before launch targets need asynchronous planning.
    if (!task.runConfiguration?.envFile?.trim() && !task.runConfiguration?.preLaunchTargets?.length) {
      onRun(task, finishHistory);
      return;
    }
    const run = async () => {
      try {
        const exitCode = await configurations.runSingleTask(task);
        finishHistory(exitCode);
      } catch (error) {
        finishHistory(1, error instanceof Error ? error.message : String(error));
      }
    };
    void run();
  }, [configurations.buildTargetsByRoot, configurations.configuredTask, onRun, configurations.runBeforeLaunch, configurations.runConfigurations, configurations.runSingleTask]);

  useImperativeHandle(ref, () => ({
    run: runTask,
    refresh: () => {
      void configurations.refresh();
    },
    rerunLast: () => {
      const last = history[0]?.task;
      if (!last) return false;
      runTask(last);
      return true;
    },
  }), [history, configurations.refresh, runTask]);

  const grouped = useMemo(() => {
    const map = new Map<string, WorkspaceTaskItem[]>();
    for (const task of tasks) map.set(task.rootId, [...(map.get(task.rootId) ?? []), task]);
    return map;
  }, [tasks]);
  const groupedConfigurations = useMemo(() => {
    const map = new Map<string, WorkspaceTaskItem[]>();
    for (const task of configurations.runConfigurations) {
      map.set(task.rootId, [...(map.get(task.rootId) ?? []), task]);
    }
    return map;
  }, [configurations.runConfigurations]);

  const renderTask = (task: WorkspaceTaskItem) => {
    const isCompound = !!task.runConfiguration?.compoundConfigurationIds?.length;
    const toolError = task.execution?.error;
    return (
      <div key={`${task.rootId}:${task.id}`} className="group flex items-center gap-1 rounded hover:bg-[var(--taomni-code-active-line-bg)]">
        <button
          type="button"
          data-testid={task.configuration ? `run-panel-configuration-${task.id}` : undefined}
          data-configuration-kind={isCompound ? "compound" : undefined}
          className="flex min-w-0 flex-1 items-center gap-1 px-1 py-1 text-left"
          title={toolError ? toolError : isCompound ? "Compound configuration" : `${task.command} — ${task.cwd}`}
          onClick={() => runTask(task)}
          disabled={!!toolError}
        >
          {toolError
            ? <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
            : <Play className="h-3 w-3 shrink-0 text-emerald-500" />}
          <span className="truncate">{task.label}</span>
          <span className="ml-auto shrink-0 text-[10px] text-[var(--taomni-code-muted)]">{task.source}</span>
          {task.runConfiguration && (
            <span
              data-testid={`run-panel-configuration-source-${task.id}`}
              data-configuration-source={task.runConfiguration.configurationSource ?? "detected"}
              className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]"
              title={`Configuration source: ${configurationSourceLabel(task.runConfiguration.configurationSource)}`}
            >
              {configurationSourceLabel(task.runConfiguration.configurationSource)}
            </span>
          )}
        </button>
        {task.custom && (
          <button
            type="button"
            aria-label={`Remove custom task ${task.label}`}
            className="px-1 text-red-500 opacity-0 group-hover:opacity-100"
            onClick={() => configurations.setCustomTasks((current) => current.filter((item) => item.id !== task.id))}
          >
            ×
          </button>
        )}
        {task.configuration && (
          <button
            type="button"
            data-testid={`run-panel-configuration-copy-${task.id}`}
            aria-label={`Copy run configuration ${task.label}`}
            title="Create named run configuration"
            className="h-6 w-6 shrink-0 rounded opacity-0 group-hover:opacity-100 focus:opacity-100"
            onClick={() => {
              const base = task.runConfiguration;
              if (!base) return;
              const copyName = `${task.label} copy`;
              const id = createNamedRunConfiguration(workspaceInstanceId, base, copyName, task.rootId);
              const copy = readRunConfigurationOverrides(workspaceInstanceId, task.rootId)[id];
              configurations.setEditingConfiguration({ rootId: task.rootId, configurationId: id });
              configurations.setConfigurationDraft({
                name: copy?.name ?? copyName,
                cwd: copy?.cwd ?? "",
                args: copy?.args.join("\n") ?? "",
                vmOptions: copy?.vmOptions?.join("\n") ?? "",
                env: formatEnvironmentLines(copy?.env ?? {}),
                envFile: copy?.envFile ?? "",
                preLaunchTargets: (copy?.preLaunchTargets ?? base.preLaunchTargets).join("\n"),
                activeProfiles: (copy?.activeProfiles ?? []).join(", "),
                properties: Object.entries(copy?.properties ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"),
              });
              void configurations.refresh();
            }}
          >
            <CopyPlus className="mx-auto h-3.5 w-3.5" />
          </button>
        )}
        {task.configuration && (
          <button
            type="button"
            data-testid={`run-panel-configuration-edit-${task.id}`}
            aria-label={`Edit run configuration ${task.label}`}
            title="Edit run configuration"
            className="h-6 w-6 shrink-0 rounded opacity-0 group-hover:opacity-100 focus:opacity-100"
            onClick={() => {
              configurations.openConfigurationEditor(task);
            }}
          >
            <SlidersHorizontal className="mx-auto h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };

  const addCustomTask = () => {
    const command = configurations.customCommand.trim();
    const root = roots.find((candidate) => candidate.id === configurations.customRootId) ?? roots[0];
    if (!command || !root) return;
    const task: WorkspaceTaskItem = {
      id: `custom:${Date.now()}`,
      label: command,
      command,
      cwd: root.path,
      source: "Custom",
      rootId: root.id,
      rootName: root.name,
      custom: true,
    };
    configurations.setCustomTasks((current) => [...current, task]);
    configurations.setCustomCommand("");
  };

  return <RunPanelView
    configurations={configurations}
    addCustomTask={addCustomTask}
    roots={roots}
    onConfigureTools={onConfigureTools}
    tasks={tasks}
    grouped={grouped}
    groupedConfigurations={groupedConfigurations}
    renderTask={renderTask}
    workspaceInstanceId={workspaceInstanceId}
    history={history}
    runTask={runTask}
  />;
});

export { type RunPanelHandle, type WorkspaceTaskItem } from "./run/model";
