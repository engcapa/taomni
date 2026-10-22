import { workspaceExecutionModel, workspaceTaskTree, type WorkspaceFile, type WorkspaceExecutionModel, type ExecutionRunConfiguration, type ExecutionDebugConfiguration, type ExecutionBuildTarget, type WorkspaceToolConfig } from "../../../../lib/editor/workspace";
import { type LspDocumentDescriptor } from "../../../../lib/editor/lsp";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import type { OpenFileEol } from "../editorGroupTypes";
import { type SaveCommitResult } from "../saveCommit";
import { mergeDebugEnvironment, readRunConfigurationOverrides } from "../runConfigurationPersistence";
import { executeTaskPlan, resolveBuildTargetPlan, validateCompoundExecutionGraph } from "../executionPlan";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, errorMessage, normalizeFsPath, relativePathWithinRoot } from "../codeWorkspaceModel";
import { type WorkspaceTaskItem } from "../panels/RunPanel";
import { type DebugLaunchGroup, type DebugLaunchNode } from "../useCodeDebugSession";
import { dapResolveJavaMainClasses, type JavaMainClassOption, type JavaMainClassResolution } from "../../../../lib/editor/dap";



export interface BuildActiveProjectContext {
  projectBuildBusy: boolean;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  activeKey: string | null;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  setProjectBuildBusy: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  toolConfigRef: import("react").RefObject<WorkspaceToolConfig | undefined>;
  launchWorkspaceTask: (task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => void;
  setStatusMessage: (message: string) => void;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  runTaskAndWait: (task: WorkspaceTaskItem) => Promise<void>;
}


export function createBuildActiveProject(controllerContext: BuildActiveProjectContext) {
  return async (rebuild = false) => {
    if (controllerContext.projectBuildBusy) return;
    const file = controllerContext.openFilesRef.current[controllerContext.activeKey ?? ""];
    const root = file?.ref.kind === "root"
      ? controllerContext.findRoot(file.ref.rootId)
      : controllerContext.rootsRef.current[0] ?? null;
    if (!root) return;
    controllerContext.setProjectBuildBusy(true);
    try {
      const absolute = file ? controllerContext.absolutePathForOpenFile(file) : undefined;
      const executionModel = await workspaceExecutionModel(root.path, absolute ?? undefined, controllerContext.toolConfigRef.current);
      const normalizedActive = absolute ? normalizeFsPath(absolute) : null;
      const project = executionModel.projects
        .filter((candidate) => !normalizedActive
          || relativePathWithinRoot(candidate.root, normalizedActive) !== null)
        .sort((left, right) => right.root.length - left.root.length)[0];
      const buildTarget = project
        ? executionModel.buildTargets.find((target) => target.projectId === project.id && target.kind === "build")
        : null;
      const cleanTarget = project
        ? executionModel.buildTargets.find((target) => target.projectId === project.id && target.kind === "clean")
        : null;
      if (buildTarget && (!rebuild || cleanTarget)) {
        const toTask = (target: ExecutionBuildTarget): WorkspaceTaskItem => ({
          id: target.id,
          label: target.label,
          command: target.command.display,
          cwd: target.command.cwd,
          source: project ? `${project.languages.join("/")} · ${project.provider}` : "Build target",
          rootId: root.id,
          rootName: root.name,
          execution: {
            executable: target.command.executable,
            args: target.command.args,
            source: target.command.source,
            error: target.command.error,
          },
          environment: Object.fromEntries(Object.entries(target.command.env).map(([name, value]) => [
            name,
            { value, mode: "replace" as const },
          ])),
          dependsOn: target.dependsOn,
        });
        const requestedIds = rebuild && cleanTarget
          ? [cleanTarget.id, buildTarget.id]
          : [buildTarget.id];
        const plan = resolveBuildTargetPlan(requestedIds, executionModel.buildTargets)
          .map(toTask);
        const result = await executeTaskPlan(plan, (task, onExit) => controllerContext.launchWorkspaceTask(task, onExit));
        if (result.exitCode !== 0) {
          throw new Error(`Build stopped at ${result.failed?.label ?? "a prerequisite"} (exit ${result.exitCode})`);
        }
        controllerContext.setStatusMessage(`${rebuild ? "Rebuilt" : "Built"} ${project?.module ?? root.name}`);
        return;
      }
      const groups = await workspaceTaskTree(root.path, controllerContext.toolConfigRef.current);
      const preferred = rebuild
        ? [["Maven", "rebuild"], ["Gradle", "rebuild"], ["Cargo.toml", "rebuild"]]
        : [
            ["Maven", "compile"],
            ["Gradle", "classes"],
            ["Gradle", "build"],
            ["Cargo.toml", "build"],
            ["package.json", "build"],
            ["Makefile", "build"],
          ];
      let selected: WorkspaceTaskItem | null = null;
      for (const [source, label] of preferred) {
        const task = groups
          .find((group) => group.source === source)
          ?.tasks.find((candidate) => candidate.label === label);
        if (task) {
          selected = { ...task, rootId: root.id, rootName: root.name };
          break;
        }
      }
      if (!selected) {
        controllerContext.setStatusMessage(rebuild
          ? "No rebuild task was detected for this project"
          : "No build task was detected for this project");
        controllerContext.setBottomDockTab("build");
        controllerContext.setBottomDockOpen(true);
        return;
      }
      await controllerContext.runTaskAndWait(selected);
      controllerContext.setStatusMessage(`${rebuild ? "Rebuilt" : "Built"} ${root.name}`);
    } catch (error) {
      controllerContext.setStatusMessage(errorMessage(error));
      controllerContext.setBottomDockTab("build");
      controllerContext.setBottomDockOpen(true);
    } finally {
      controllerContext.setProjectBuildBusy(false);
    }
  };
}



export interface StartDebugActiveFileContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  activeKey: string | null;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  workspaceInstanceId: string;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  debug: import("../useCodeDebugSession").CodeDebugSession;
  saveOpenBufferText: (key: string, textToSave?: string, saveOptions?: { eol?: OpenFileEol | "lf" | "crlf" | "cr"; encoding?: string; bom?: boolean; }, onCommitResult?: (result: SaveCommitResult) => void) => Promise<WorkspaceFile | null>;
  executeBeforeLaunch: (targetIds: readonly string[], targets: readonly ExecutionBuildTarget[], root: CodeWorkspaceRootInfo) => Promise<void>;
  activeRunConfiguration: ExecutionRunConfiguration | null;
  activeExecutionModel: WorkspaceExecutionModel | null;
  setStatusMessage: (message: string) => void;
  prepareJavaLaunch: (rootId: string, launchDescriptor?: LspDocumentDescriptor | null) => Promise<boolean>;
  mountedRef: import("react").MutableRefObject<boolean>;
  readEnvironmentFile: (cwd: string, envFile: string | undefined) => Promise<Record<string, string>>;
  setJavaMainCandidates: import("react").Dispatch<import("react").SetStateAction<{ candidates: JavaMainClassOption[]; launch: Record<string, unknown>; override?: ReturnType<typeof readRunConfigurationOverrides>[string]; environment: Record<string, string>; runtimeOptions: string[]; } | null>>;
  activeRunConfigurationOverride: import("../runConfigurationPersistence").RunConfigurationOverride | undefined;
  launchJavaDebug: (launch: Record<string, unknown>, main?: JavaMainClassOption, override?: import("../runConfigurationPersistence").RunConfigurationOverride | undefined, environment?: Record<string, string>, runtimeOptions?: readonly string[]) => void;
}


export function createStartDebugActiveFile(controllerContext: StartDebugActiveFileContext) {
  return () => {
    const file = controllerContext.openFilesRef.current[controllerContext.activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return;
    const root = controllerContext.findRoot(file.ref.rootId);
    if (!root) return;
    const absolute = controllerContext.absolutePathForOpenFile(file);
    if (!absolute) return;
    const descriptor = controllerContext.lspDescriptorForFile(file);
    const rootId = file.ref.rootId;
    const launch: Record<string, unknown> = {
      workspaceId: descriptor?.workspaceId ?? controllerContext.workspaceInstanceId,
      rootPath: root.path,
      filePath: absolute,
      cwd: root.path,
      // Bind the debug session to the same jdtls the editor uses (custom command).
      serverCommandId: descriptor?.serverCommandId ?? null,
      customServerCommand: descriptor?.customServerCommand ?? null,
    };
    controllerContext.setBottomDockTab("debug");
    controllerContext.setBottomDockOpen(true);
    // Show the session console from the first click: everything below (save,
    // build, main-class resolution) happens before an adapter exists and can
    // take tens of seconds on a cold project.
    controllerContext.debug.reportStartupProgress(`Starting debug for ${file.title}`);
    void (async () => {
      try {
        if (file.dirty) await controllerContext.saveOpenBufferText(file.key, file.text);
        await controllerContext.executeBeforeLaunch(
          controllerContext.activeRunConfiguration?.preLaunchTargets ?? [],
          controllerContext.activeExecutionModel?.buildTargets ?? [],
          root,
        );
      } catch (error) {
        const message = `Cannot start debug: ${errorMessage(error)}`;
        controllerContext.setStatusMessage(message);
        controllerContext.debug.reportStartupFailure(message);
        return;
      }
      // jdtls remains the Java-specific compiler/diagnostic barrier. When a
      // structured Before launch build already ran, do not compile twice.
      if (!(controllerContext.activeRunConfiguration?.preLaunchTargets.length)
        && !(await controllerContext.prepareJavaLaunch(rootId, descriptor))) return;
      // Resolve the runnable main up front: launch the active-file / sole main
      // directly, or prompt when several mains exist (never run an arbitrary one).
      controllerContext.debug.reportStartupProgress("Resolving main class…");
      let resolution: JavaMainClassResolution;
      try {
        resolution = await dapResolveJavaMainClasses(launch);
      } catch (err) {
        // Surface in the Debug panel (not just the status bar): a rejected
        // resolve is the common "no active jdtls session / no debug bundle"
        // failure, and the transient status message is easy to miss.
        const message = errorMessage(err);
        controllerContext.setStatusMessage(message);
        controllerContext.debug.reportStartupFailure(`Debug failed to start: ${message}`);
        return;
      }
      if (!controllerContext.mountedRef.current) return;
      if (resolution.kind === "none") {
        const message = "No runnable main class found in this Java project";
        controllerContext.setStatusMessage(message);
        controllerContext.debug.reportStartupFailure(message);
        return;
      }
      if (resolution.kind === "choose") {
        let dotenv: Record<string, string> = {};
        try {
          dotenv = await controllerContext.readEnvironmentFile(
            controllerContext.activeRunConfiguration?.command.cwd ?? root.path,
            controllerContext.activeRunConfiguration?.envFile,
          );
        } catch (error) {
          const message = `Cannot start debug: ${errorMessage(error)}`;
          controllerContext.setStatusMessage(message);
          controllerContext.debug.reportStartupFailure(message);
          return;
        }
        controllerContext.debug.reportStartupProgress("Waiting for a main class to be picked…");
        controllerContext.setJavaMainCandidates({
          candidates: resolution.candidates,
          launch,
          override: controllerContext.activeRunConfigurationOverride,
          environment: dotenv,
          runtimeOptions: [...(controllerContext.activeRunConfiguration?.runtimeOptions ?? [])],
        });
        return;
      }
      let dotenv: Record<string, string> = {};
      try {
        dotenv = await controllerContext.readEnvironmentFile(
          controllerContext.activeRunConfiguration?.command.cwd ?? root.path,
          controllerContext.activeRunConfiguration?.envFile,
        );
      } catch (error) {
        const message = `Cannot start debug: ${errorMessage(error)}`;
        controllerContext.setStatusMessage(message);
        controllerContext.debug.reportStartupFailure(message);
        return;
      }
      controllerContext.launchJavaDebug(
        launch,
        resolution.main,
        controllerContext.activeRunConfigurationOverride,
        dotenv,
        controllerContext.activeRunConfiguration?.runtimeOptions,
      );
    })();
  };
}



export interface StartDebugActiveTargetContext {
  activeFileIsJava: boolean;
  activeRunConfiguration: ExecutionRunConfiguration | null;
  activeDebugConfiguration: ExecutionDebugConfiguration | null;
  startDebugActiveFile: () => void;
  setStatusMessage: (message: string) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  activeKey: string | null;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  debug: import("../useCodeDebugSession").CodeDebugSession;
  saveOpenBufferText: (key: string, textToSave?: string, saveOptions?: { eol?: OpenFileEol | "lf" | "crlf" | "cr"; encoding?: string; bom?: boolean; }, onCommitResult?: (result: SaveCommitResult) => void) => Promise<WorkspaceFile | null>;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  activeDebugConfigurationCatalog: ExecutionDebugConfiguration[];
  activeExecutionModel: WorkspaceExecutionModel | null;
  roots: CodeWorkspaceRootInfo[];
  readEnvironmentFile: (cwd: string, envFile: string | undefined) => Promise<Record<string, string>>;
  executeBeforeLaunch: (targetIds: readonly string[], targets: readonly ExecutionBuildTarget[], root: CodeWorkspaceRootInfo) => Promise<void>;
}


export function createStartDebugActiveTarget(controllerContext: StartDebugActiveTargetContext) {
  return () => {
    // A Java source without a selected structured debug configuration uses the
    // compatibility jdtls launch path. Once a configuration supplies a debug
    // entry, honor its availability first so compound/debug-only entries cannot
    // silently fall through to the compatibility launcher.
    const canUseJavaCompatibilityDebug = controllerContext.activeFileIsJava
      && !controllerContext.activeRunConfiguration?.debugConfigurationId
      && controllerContext.activeRunConfiguration?.kind !== "debug-only";
    if (canUseJavaCompatibilityDebug && !controllerContext.activeDebugConfiguration) {
      controllerContext.startDebugActiveFile();
      return;
    }
    if (controllerContext.activeFileIsJava && !controllerContext.activeDebugConfiguration) {
      controllerContext.setStatusMessage("No available debug configuration is associated with the selected Run configuration");
      return;
    }
    const configuration = controllerContext.activeDebugConfiguration;
    if (!configuration?.available) {
      if (configuration?.diagnostic) controllerContext.setStatusMessage(configuration.diagnostic);
      return;
    }
    const file = controllerContext.openFilesRef.current[controllerContext.activeKey ?? ""];
    if (!file || file.ref.kind !== "root" || file.library) return;
    const rootId = file.ref.rootId;
    controllerContext.setBottomDockTab("debug");
    controllerContext.setBottomDockOpen(true);
    controllerContext.debug.reportStartupProgress(`Starting ${configuration.label}`);
    void (async () => {
      try {
        if (file.dirty) await controllerContext.saveOpenBufferText(file.key, file.text);
        const root = controllerContext.findRoot(rootId);
        if (!root) throw new Error("Cannot resolve the active workspace root");
        const catalog = controllerContext.activeDebugConfigurationCatalog;
        const buildTargets = controllerContext.activeExecutionModel?.buildTargets ?? [];
        const resolveRoot = (candidate: ExecutionDebugConfiguration): CodeWorkspaceRootInfo => {
          const project = controllerContext.activeExecutionModel?.projects.find((item) => item.id === candidate.projectId);
          const projectRoot = project && controllerContext.roots.find((item) => (
            relativePathWithinRoot(item.path, project.root) !== null
          ));
          if (!projectRoot || projectRoot.id !== root.id) {
            throw new Error(`Compound Debug child belongs to another workspace root: ${candidate.label}`);
          }
          return projectRoot;
        };
        const nodes = validateCompoundExecutionGraph(
          configuration,
          catalog.filter((candidate) => candidate.id !== configuration.id),
        );
        const validated = new Map<string, ExecutionDebugConfiguration>();
        const collectReachable = (candidate: ExecutionDebugConfiguration) => {
          if (validated.has(candidate.id)) return;
          if (!candidate.available) {
            throw new Error(candidate.diagnostic || `Debug configuration is unavailable: ${candidate.label}`);
          }
          resolveRoot(candidate);
          resolveBuildTargetPlan(candidate.preLaunchTargets, buildTargets);
          validated.set(candidate.id, candidate);
          for (const childId of candidate.compoundConfigurationIds ?? []) {
            const child = nodes.get(childId);
            if (!child) throw new Error(`Compound Debug child is missing: ${childId}`);
            collectReachable(child);
          }
        };
        collectReachable(configuration);
        // Resolve every dotenv before any build or adapter process starts. A
        // malformed/missing later child must never leave a half-launched group.
        const launches = new Map<string, ExecutionDebugConfiguration>();
        await Promise.all(Array.from(validated.values()).map(async (candidate) => {
          if (candidate.compoundConfigurationIds !== undefined) return;
          const candidateRoot = resolveRoot(candidate);
          const cwdValue = candidate.launchConfig.adapterCwd;
          const cwd = typeof cwdValue === "string" && cwdValue.trim() ? cwdValue : candidateRoot.path;
          const dotenv = await controllerContext.readEnvironmentFile(cwd, candidate.envFile);
          launches.set(candidate.id, mergeDebugEnvironment(candidate, dotenv));
        }));
        const buildPlan = (candidate: ExecutionDebugConfiguration): DebugLaunchNode => {
          const childIds = candidate.compoundConfigurationIds;
          if (childIds === undefined) {
            const launch = launches.get(candidate.id);
            if (!launch) throw new Error(`Compound Debug launch was not resolved: ${candidate.label}`);
            return {
              id: launch.id,
              label: launch.label,
              adapterId: launch.adapterId,
              launchConfig: launch.launchConfig,
            };
          }
          return {
            id: candidate.id,
            label: candidate.label,
            parallel: candidate.compoundParallel,
            stopOnFailure: candidate.compoundStopOnFailure,
            children: childIds.map((childId) => {
              const child = validated.get(childId);
              if (!child) throw new Error(`Compound Debug child is missing: ${childId}`);
              return buildPlan(child);
            }),
          } satisfies DebugLaunchGroup;
        };
        // Before-launch tasks are completed for the validated graph before DAP
        // startup. Resolve the union once so shared dependencies execute once.
        await controllerContext.executeBeforeLaunch(
          Array.from(validated.values()).flatMap((candidate) => candidate.preLaunchTargets),
          buildTargets,
          root,
        );
        const plan = buildPlan(configuration);
        if ("children" in plan) await controllerContext.debug.startDebugGroup(plan);
        else await controllerContext.debug.startDebug(plan.launchConfig, plan.adapterId);
      } catch (error) {
        const message = `Debug failed to start: ${errorMessage(error)}`;
        controllerContext.setStatusMessage(message);
        controllerContext.debug.reportStartupFailure(message);
      }
    })();
  };
}
