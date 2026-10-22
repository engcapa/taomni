import { type RefObject, useEffect, useMemo, useState } from "react";
import { workspaceJavaRunTarget, workspaceExecutionModel, type WorkspaceExecutionModel, type ExecutionRunConfiguration, type ExecutionDebugConfiguration, type WorkspaceToolConfig } from "../../../../lib/editor/workspace";
import { applyRunOverrideToDebugConfiguration, javaRunTargetToExecutionRunConfiguration, materializeRunConfigurations, readActiveRunConfigurationSelection, readRunConfigurationOverrides, RUN_CONFIGURATION_CHANGED_EVENT } from "../runConfigurationPersistence";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, errorMessage, fsPathEquals, normalizeFsPath, relativePathWithinRoot } from "../codeWorkspaceModel";

export interface UseExecutionTargetsContext {
  workspaceInstanceId: string;
  openFilesRef: RefObject<Record<string, OpenFileState>>;
  activeKey: string | null;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  toolConfigRef: RefObject<WorkspaceToolConfig | undefined>;
  activeFileIsJava: boolean;
  setStatusMessage: (message: string) => void;
  toolConfig: WorkspaceToolConfig | undefined;
  activeFile: OpenFileState | null;
  roots: CodeWorkspaceRootInfo[];
}

export function useExecutionTargets(context: UseExecutionTargetsContext) {
  const {
    workspaceInstanceId,
    openFilesRef,
    activeKey,
    findRoot,
    absolutePathForOpenFile,
    toolConfigRef,
    activeFileIsJava,
    setStatusMessage,
    toolConfig,
    activeFile,
    roots,
  } = context;

  const [activeExecutionModel, setActiveExecutionModel] = useState<WorkspaceExecutionModel | null>(null);
  const [javaFallbackConfiguration, setJavaFallbackConfiguration] = useState<ExecutionRunConfiguration | null>(null);
  const [runConfigurationRevision, setRunConfigurationRevision] = useState(0);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceInstanceId?: string }>).detail;
      if (detail?.workspaceInstanceId === workspaceInstanceId) {
        setRunConfigurationRevision((revision) => revision + 1);
      }
    };
    window.addEventListener(RUN_CONFIGURATION_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(RUN_CONFIGURATION_CHANGED_EVENT, onChanged);
  }, [workspaceInstanceId]);

  useEffect(() => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root" || file.library) {
      setActiveExecutionModel(null);
      setJavaFallbackConfiguration(null);
      return;
    }
    const root = findRoot(file.ref.rootId);
    const absolute = absolutePathForOpenFile(file);
    if (!root || !absolute) {
      setActiveExecutionModel(null);
      setJavaFallbackConfiguration(null);
      return;
    }
    let cancelled = false;
    setActiveExecutionModel(null);
    setJavaFallbackConfiguration(null);
    void workspaceExecutionModel(root.path, absolute, toolConfigRef.current)
      .then((model) => {
        if (cancelled) return;
        setActiveExecutionModel(model);
        if (activeFileIsJava) {
          void workspaceJavaRunTarget(root.path, file.ref.path, toolConfigRef.current)
            .then((target) => {
              if (!cancelled) setJavaFallbackConfiguration(javaRunTargetToExecutionRunConfiguration(target));
            })
            .catch(() => {
              if (!cancelled) setJavaFallbackConfiguration(null);
            });
        }
      })
      .catch((error) => {
        if (!cancelled) setStatusMessage(`Run target discovery failed: ${errorMessage(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [absolutePathForOpenFile, activeFileIsJava, activeKey, findRoot, setStatusMessage, toolConfig]);

  const activeRunConfigurations = useMemo<ExecutionRunConfiguration[]>(() => {
    if (!activeExecutionModel || !activeFile || activeFile.ref.kind !== "root") return [];
    const absolute = absolutePathForOpenFile(activeFile);
    if (!absolute) return [];
    const normalized = normalizeFsPath(absolute);
    const activeRootId = activeFile.ref.kind === "root" ? activeFile.ref.rootId : null;
    const activeRoot = activeRootId ? roots.find((root) => root.id === activeRootId) : undefined;
    if (!activeRoot) return [];
    const projectRoots = new Map(
      activeExecutionModel.projects.map((project) => [project.id, normalizeFsPath(project.root)]),
    );
    const configurations = javaFallbackConfiguration
      ? [
          ...activeExecutionModel.runConfigurations.filter((configuration) => (
            configuration.configurationSource === "shared"
            || !configuration.sourceFile
            || !fsPathEquals(configuration.sourceFile, javaFallbackConfiguration.sourceFile ?? "")
          )),
          javaFallbackConfiguration,
        ]
      : activeExecutionModel.runConfigurations;
    const matches = configurations.filter((configuration) => {
      const sourceFile = configuration.sourceFile && normalizeFsPath(configuration.sourceFile);
      if (sourceFile) {
        return fsPathEquals(sourceFile, normalized)
          && relativePathWithinRoot(activeRoot.path, sourceFile) !== null;
      }
      const projectRoot = projectRoots.get(configuration.projectId);
      // A project-level configuration belongs to the active file only when its
      // project is rooted below the active workspace root. This keeps multiple
      // workspace roots and nested Maven/Gradle modules isolated.
      return !!projectRoot
        && relativePathWithinRoot(activeRoot.path, projectRoot) !== null
        && relativePathWithinRoot(projectRoot, normalized) !== null;
    });
    return materializeRunConfigurations(
      matches,
      readRunConfigurationOverrides(workspaceInstanceId, activeRoot.id),
    );
  }, [absolutePathForOpenFile, activeExecutionModel, activeFile, javaFallbackConfiguration, roots, runConfigurationRevision, workspaceInstanceId]);

  const activeRunConfiguration = useMemo<ExecutionRunConfiguration | null>(() => {
    const candidates = activeRunConfigurations.filter((configuration) => configuration.kind !== "module");
    if (candidates.length === 0) return null;
    const selectedId = activeFile
      ? readActiveRunConfigurationSelection(workspaceInstanceId, absolutePathForOpenFile(activeFile) ?? "")
      : null;
    return candidates.find((configuration) => configuration.id === selectedId) ?? candidates[0];
  }, [absolutePathForOpenFile, activeFile, activeRunConfigurations, runConfigurationRevision, workspaceInstanceId]);

  const activeDebugConfiguration = useMemo<ExecutionDebugConfiguration | null>(() => {
    const id = activeRunConfiguration?.debugConfigurationId;
    if (!id || !activeExecutionModel) return null;
    const detected = activeExecutionModel.debugConfigurations.find((configuration) => configuration.id === id) ?? null;
    if (!detected) return null;
    const rootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : undefined;
    const override = readRunConfigurationOverrides(workspaceInstanceId, rootId)[activeRunConfiguration.id];
    return applyRunOverrideToDebugConfiguration(
      detected,
      override,
      activeRunConfiguration.runtimeOptions,
      activeRunConfiguration.envFile,
    );
  }, [activeExecutionModel, activeFile, activeRunConfiguration, runConfigurationRevision, workspaceInstanceId]);

  const activeDebugConfigurationCatalog = useMemo<ExecutionDebugConfiguration[]>(() => {
    if (!activeExecutionModel || !activeFile || activeFile.ref.kind !== "root") return [];
    const overrides = readRunConfigurationOverrides(workspaceInstanceId, activeFile.ref.rootId);
    const runByDebugId = new Map<string, ExecutionRunConfiguration>();
    for (const run of activeRunConfigurations) {
      if (run.debugConfigurationId && !runByDebugId.has(run.debugConfigurationId)) {
        runByDebugId.set(run.debugConfigurationId, run);
      }
    }
    return activeExecutionModel.debugConfigurations.map((configuration) => {
      const run = runByDebugId.get(configuration.id);
      const override = run
        ? overrides[run.id] ?? (run.baseConfigurationId ? overrides[run.baseConfigurationId] : undefined)
        : undefined;
      return applyRunOverrideToDebugConfiguration(
        configuration,
        override,
        run?.runtimeOptions,
        run?.envFile,
      );
    });
  }, [activeExecutionModel, activeFile, activeRunConfigurations, runConfigurationRevision, workspaceInstanceId]);

  const activeRunConfigurationOverride = useMemo(() => {
    if (!activeRunConfiguration) return undefined;
    const rootId = activeFile?.ref.kind === "root" ? activeFile.ref.rootId : undefined;
    const overrides = readRunConfigurationOverrides(workspaceInstanceId, rootId);
    return overrides[activeRunConfiguration.id]
      ?? (activeRunConfiguration.baseConfigurationId
        ? overrides[activeRunConfiguration.baseConfigurationId]
        : undefined);
  }, [activeFile, activeRunConfiguration, runConfigurationRevision, workspaceInstanceId]);
  return {
    activeExecutionModel,
    runConfigurationRevision,
    activeRunConfiguration,
    activeRunConfigurationOverride,
    activeDebugConfiguration,
    activeDebugConfigurationCatalog,
    activeRunConfigurations,
  };
}
