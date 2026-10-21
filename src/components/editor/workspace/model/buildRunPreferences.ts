import type { WorkspaceToolConfig } from "../../../../lib/editor/workspace";
import { type WorkspaceDebugStepFilters, type WorkspaceBuildRunTools, type WorkspaceBuildRunTool } from "./types";

export const DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS: WorkspaceDebugStepFilters = {
  enabled: true,
  patterns: [
    "java.*",
    "javax.*",
    "sun.*",
    "com.sun.*",
    "jdk.*",
    "org.gradle.*",
    "org.apache.maven.*",
  ],
  skipSynthetics: true,
  skipStaticInitializers: false,
  skipConstructors: false,
};

export const DEFAULT_WORKSPACE_BUILD_RUN_TOOLS: WorkspaceBuildRunTools = {
  tools: {},
  mavenRun: {
    jvmArgs: [],
    inheritProjectJvmArgs: true,
  },
  stepFilters: DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS,
};

export const WORKSPACE_BUILD_RUN_TOOLS_KEY_PREFIX = "taomni.codeWorkspace.buildRunTools.v1";

export function normalizeWorkspaceBuildRunTools(raw: unknown): WorkspaceBuildRunTools {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_WORKSPACE_BUILD_RUN_TOOLS;
  }
  const config = raw as {
    tools?: unknown;
    mavenRun?: { jvmArgs?: unknown; inheritProjectJvmArgs?: unknown; };
  };
  const rawTools = config.tools;
  const tools: Record<string, WorkspaceBuildRunTool> = {};
  if (rawTools && typeof rawTools === "object" && !Array.isArray(rawTools)) {
    for (const [toolId, value] of Object.entries(rawTools)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const executable = (value as { executable?: unknown; }).executable;
      if (typeof executable === "string" && executable.trim()) {
        tools[toolId] = { executable: executable.trim() };
      }
    }
  }
  const rawJvmArgs = config.mavenRun?.jvmArgs;
  const jvmArgs = Array.isArray(rawJvmArgs)
    ? rawJvmArgs.filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  const rawStepFilters = (config as { stepFilters?: unknown; }).stepFilters;
  let stepFilters: WorkspaceDebugStepFilters = DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS;
  if (rawStepFilters && typeof rawStepFilters === "object" && !Array.isArray(rawStepFilters)) {
    const rawPatterns = (rawStepFilters as { patterns?: unknown; }).patterns;
    const patterns = Array.isArray(rawPatterns)
      ? rawPatterns.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean)
      : DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS.patterns;
    stepFilters = {
      enabled: typeof (rawStepFilters as { enabled?: unknown; }).enabled === "boolean"
        ? (rawStepFilters as { enabled: boolean; }).enabled
        : true,
      patterns,
      skipSynthetics: typeof (rawStepFilters as { skipSynthetics?: unknown; }).skipSynthetics === "boolean"
        ? (rawStepFilters as { skipSynthetics: boolean; }).skipSynthetics
        : true,
      skipStaticInitializers: typeof (rawStepFilters as { skipStaticInitializers?: unknown; }).skipStaticInitializers === "boolean"
        ? (rawStepFilters as { skipStaticInitializers: boolean; }).skipStaticInitializers
        : false,
      skipConstructors: typeof (rawStepFilters as { skipConstructors?: unknown; }).skipConstructors === "boolean"
        ? (rawStepFilters as { skipConstructors: boolean; }).skipConstructors
        : false,
    };
  }
  return {
    tools,
    mavenRun: {
      jvmArgs,
      inheritProjectJvmArgs: typeof config.mavenRun?.inheritProjectJvmArgs === "boolean"
        ? config.mavenRun.inheritProjectJvmArgs
        : true,
    },
    stepFilters,
  };
}

export function workspaceBuildRunToolsKey(workspaceInstanceId: string): string {
  return `${WORKSPACE_BUILD_RUN_TOOLS_KEY_PREFIX}.${workspaceInstanceId}`;
}

export function readWorkspaceBuildRunTools(workspaceInstanceId: string): WorkspaceBuildRunTools {
  try {
    const stored = window.localStorage.getItem(workspaceBuildRunToolsKey(workspaceInstanceId));
    return stored ? normalizeWorkspaceBuildRunTools(JSON.parse(stored)) : DEFAULT_WORKSPACE_BUILD_RUN_TOOLS;
  } catch {
    return DEFAULT_WORKSPACE_BUILD_RUN_TOOLS;
  }
}

export function writeWorkspaceBuildRunTools(
  workspaceInstanceId: string,
  config: WorkspaceBuildRunTools,
): WorkspaceBuildRunTools {
  const normalized = normalizeWorkspaceBuildRunTools(config);
  try {
    window.localStorage.setItem(workspaceBuildRunToolsKey(workspaceInstanceId), JSON.stringify(normalized));
  } catch {
    // Ignore storage failures.
  }
  return normalized;
}

export function workspaceToolExecutables(config: WorkspaceBuildRunTools): Record<string, string> {
  return Object.fromEntries(Object.entries(config.tools).map(([id, tool]) => [id, tool.executable]));
}

/**
 * Omit the default-only shape to preserve the existing wrapper/PATH-only IPC
 * contract. The backend treats an omitted config as project-argument inheritance
 * enabled, so Java Run gets safe Maven module flags without changing Build tasks.
 */
export function workspaceToolConfig(config: WorkspaceBuildRunTools): WorkspaceToolConfig | undefined {
  const executables = workspaceToolExecutables(config);
  const { jvmArgs, inheritProjectJvmArgs } = config.mavenRun;
  if (Object.keys(executables).length === 0 && jvmArgs.length === 0 && inheritProjectJvmArgs) {
    return undefined;
  }
  return {
    ...executables,
    mavenJvmArgs: jvmArgs,
    inheritMavenArgLine: inheritProjectJvmArgs,
  };
}
