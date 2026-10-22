import type { ExecutionBuildTarget } from "../../../../../lib/editor/workspace";
import { type ExecutionRunConfiguration } from "../../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../../types";
import { type WorkspaceTaskItem } from "./model";

export function configurationSourceLabel(source: ExecutionRunConfiguration["configurationSource"]): string {
  switch (source) {
    case "shared":
      return "Shared";
    case "local":
      return "Local";
    case "provider":
      return "Provider";
    default:
      return "Detected";
  }
}

export function customTasksKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.customTasks.v1.${workspaceInstanceId}`;
}

export function readCustomTasks(workspaceInstanceId: string): WorkspaceTaskItem[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(customTasksKey(workspaceInstanceId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((task): task is WorkspaceTaskItem => (
      !!task && typeof task.command === "string" && typeof task.cwd === "string"
    )) : [];
  } catch {
    return [];
  }
}

export function taskForExecutionConfiguration(
  configuration: ExecutionRunConfiguration,
  root: Pick<CodeWorkspaceRootInfo, "id" | "name">,
  source: string,
  buildTargets: ExecutionBuildTarget[],
  defaults: ExecutionRunConfiguration = configuration,
): WorkspaceTaskItem {
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
    runConfigurationDefaults: defaults,
    execution: {
      executable: configuration.command.executable,
      args: configuration.command.args,
      source: configuration.command.source,
      error: configuration.command.error,
    },
    environment: Object.fromEntries(Object.entries(configuration.command.env).map(([name, value]) => [
      name,
      { value, mode: configuration.environmentModes?.[name] ?? "replace" },
    ])),
    dependsOn: configuration.preLaunchTargets,
    buildTargets,
  };
}
