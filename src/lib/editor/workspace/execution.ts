import { invoke } from "@tauri-apps/api/core";
import {
  type DependencyNode,
  type JavaRunTarget,
  type StructuredTestResults,
  type WorkspaceExecutionModel,
  type WorkspaceTask,
  type WorkspaceTaskGroup,
  type WorkspaceToolConfig,
} from "./executionModel";

export function workspaceDetectTasks(
  repoRoot: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<WorkspaceTask[]> {
  return invoke<WorkspaceTask[]>("workspace_detect_tasks", { repoRoot, toolConfig: toolConfig ?? null });
}

/** Discover structured projects and first-class Build/Run/Debug capabilities. */
export function workspaceExecutionModel(
  repoRoot: string,
  activeFile?: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<WorkspaceExecutionModel> {
  return invoke<WorkspaceExecutionModel>("workspace_execution_model", {
    repoRoot,
    activeFile: activeFile ?? null,
    toolConfig: toolConfig ?? null,
  });
}

/** Discover runnable Java main classes without requiring the java-debug bundle. */
export function workspaceJavaRunTargets(
  repoRoot: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<JavaRunTarget[]> {
  return invoke<JavaRunTarget[]>("workspace_java_run_targets", { repoRoot, toolConfig: toolConfig ?? null });
}

/** Resolve the Java main class declared in one workspace-relative source file. */
export function workspaceJavaRunTarget(
  repoRoot: string,
  filePath: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<JavaRunTarget> {
  return invoke<JavaRunTarget>("workspace_java_run_target", {
    repoRoot,
    filePath,
    toolConfig: toolConfig ?? null,
  });
}

/**
 * Grouped task tree: Maven/Gradle carry their full lifecycle / common tasks;
 * other ecosystems group their detected tasks by source. Pure/offline (no build
 * tool is spawned).
 */
export function workspaceTaskTree(
  repoRoot: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<WorkspaceTaskGroup[]> {
  return invoke<WorkspaceTaskGroup[]>("workspace_task_tree", { repoRoot, toolConfig: toolConfig ?? null });
}

/** Read bounded JUnit-style results produced below a workspace root. */
export function workspaceTestResults(repoRoot: string, notBeforeMs?: number): Promise<StructuredTestResults> {
  return invoke<StructuredTestResults>("workspace_test_results", {
    repoRoot,
    notBeforeMs: notBeforeMs ?? null,
  });
}

/**
 * Resolve the project dependency tree by spawning the build tool
 * (`mvn dependency:tree` / `gradle dependencies`). Slow on a cold cache; requires
 * the tool (or wrapper) present. Rejects for non-Maven/Gradle projects.
 */
export function workspaceDependencyTree(
  repoRoot: string,
  toolConfig?: WorkspaceToolConfig,
): Promise<DependencyNode[]> {
  return invoke<DependencyNode[]>("workspace_dependency_tree", { repoRoot, toolConfig: toolConfig ?? null });
}
