import type { CodeDebugSession } from "../useCodeDebugSession";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { workspaceTaskTree, workspaceTestResults, type WorkspaceToolConfig, type StructuredTestResult, type StructuredTestResults } from "../../../../lib/editor/workspace";
import { javaTestDiscover, javaTestResolveLaunch, type JavaTestItem, type LspDocumentDescriptor, type LspLocation, type LspRange } from "../../../../lib/editor/lsp";
import { type BottomDockTabId, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, absoluteWorkspacePath, errorMessage, fileKey, normalizeFsPath } from "../codeWorkspaceModel";
import { type WorkspaceTaskItem } from "../panels/RunPanel";
import { javaTestRunCommand, type JavaTestBuildTool } from "../panels/javaTestRun";

export interface UseWorkspaceTestsContext {
  openFilesRef: RefObject<Record<string, OpenFileState>>;
  activeKey: string | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  mountedRef: RefObject<boolean>;
  workspaceInstanceId: string;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  activeFileIsJava: boolean;
  activeFile: OpenFileState | null;
  toolConfigRef: RefObject<WorkspaceToolConfig | undefined>;
  runWorkspaceTask: (task: WorkspaceTaskItem, onExit?: (exitCode: number) => void) => void;
  setStatusMessage: (message: string) => void;
  problemPathToRef: (rawPath: string) => CodeWorkspaceFileRef | null;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  revealEditorLocation: (key: string, range: LspLocation["range"]) => void;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  prepareJavaLaunchRef: RefObject<(rootId: string, launchDescriptor?: LspDocumentDescriptor | null) => Promise<boolean>>;
  debugRef: RefObject<CodeDebugSession | null>;
}

export function useWorkspaceTests(context: UseWorkspaceTestsContext) {
  const {
    openFilesRef,
    activeKey,
    lspDescriptorForFile,
    findRoot,
    mountedRef,
    workspaceInstanceId,
    bottomDockOpen,
    bottomDockTab,
    activeFileIsJava,
    activeFile,
    toolConfigRef,
    runWorkspaceTask,
    setStatusMessage,
    problemPathToRef,
    openFile,
    revealEditorLocation,
    absolutePathForOpenFile,
    setBottomDockTab,
    setBottomDockOpen,
    debugRef,
  } = context;
  const [testResultsByRoot, setTestResultsByRoot] = useState<Record<string, StructuredTestResults>>({});
  const testResultsWorkspaceRef = useRef(workspaceInstanceId);
  testResultsWorkspaceRef.current = workspaceInstanceId;

  useEffect(() => {
    setTestResultsByRoot({});
  }, [workspaceInstanceId]);

  const [javaTestBuildTool, setJavaTestBuildTool] = useState<JavaTestBuildTool | null>(null);
  const [javaTestCommand, setJavaTestCommand] = useState<string | null>(null);

  const discoverActiveJavaTests = useCallback(async () => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file) return [];
    const descriptor = lspDescriptorForFile(file);
    if (!descriptor) return [];
    return javaTestDiscover(descriptor);
  }, [activeKey, lspDescriptorForFile]);

  const loadTestResultsForRoot = useCallback(async (
    root: CodeWorkspaceRootInfo,
    notBeforeMs?: number,
  ): Promise<StructuredTestResults> => {
    const results = await workspaceTestResults(root.path, notBeforeMs);
    const currentRoot = findRoot(root.id);
    if (
      mountedRef.current
      && testResultsWorkspaceRef.current === workspaceInstanceId
      && currentRoot?.path === root.path
    ) {
      setTestResultsByRoot((current) => ({ ...current, [root.id]: results }));
    }
    return results;
  }, [findRoot, mountedRef, workspaceInstanceId]);

  const loadActiveJavaTestResults = useCallback(async (): Promise<StructuredTestResults | null> => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return null;
    const root = findRoot(file.ref.rootId);
    return root ? loadTestResultsForRoot(root) : null;
  }, [activeKey, findRoot, loadTestResultsForRoot]);

  // Detect the active file's build tool (Maven/Gradle) for the run command; only
  // while the Tests tab is open for a Java file. Cached per detection.
  useEffect(() => {
    if (!(bottomDockOpen && bottomDockTab === "tests" && activeFileIsJava && activeFile)) return;
    if (activeFile.ref.kind !== "root") {
      setJavaTestBuildTool(null);
      setJavaTestCommand(null);
      return;
    }
    const root = findRoot(activeFile.ref.rootId);
    if (!root) return;
    let cancelled = false;
    void workspaceTaskTree(root.path, toolConfigRef.current)
      .then((groups) => {
        if (cancelled) return;
        const mavenTask = groups
          .find((group) => group.source === "Maven")
          ?.tasks.find((task) => task.label === "test");
        const gradleTask = groups
          .find((group) => group.source === "Gradle")
          ?.tasks.find((task) => task.label === "test");
        const task = mavenTask ?? gradleTask;
        setJavaTestBuildTool(mavenTask ? "maven" : gradleTask ? "gradle" : null);
        setJavaTestCommand(task?.command ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setJavaTestBuildTool(null);
          setJavaTestCommand(null);
        }
      });
    return () => { cancelled = true; };
  }, [activeFile, activeFileIsJava, bottomDockOpen, bottomDockTab, findRoot]);

  const runJavaTest = useCallback((item: JavaTestItem) => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root" || !javaTestBuildTool || !javaTestCommand) return;
    const root = findRoot(file.ref.rootId);
    if (!root) return;
    const command = javaTestRunCommand(javaTestBuildTool, item, javaTestCommand);
    const startedAt = Date.now();
    runWorkspaceTask({
      id: `java-test:${item.fullName}`,
      label: `Test ${item.name}`,
      command,
      cwd: root.path,
      source: "Test",
      rootId: root.id,
      rootName: root.name,
    }, (exitCode) => {
      // The terminal exit code is only execution status; the JUnit report is
      // the durable test protocol and remains authoritative for individual
      // cases, skips, errors, and stack traces.
      // Filesystems with coarse timestamp resolution can report a freshly
      // written XML file a few milliseconds before the PTY start marker.
      void loadTestResultsForRoot(root, Math.max(0, startedAt - 2000)).catch((error) => {
        if (testResultsWorkspaceRef.current !== workspaceInstanceId) return;
        setStatusMessage(`Test results unavailable after exit ${exitCode}: ${errorMessage(error)}`);
      });
    });
  }, [
    activeKey,
    findRoot,
    javaTestBuildTool,
    javaTestCommand,
    loadTestResultsForRoot,
    runWorkspaceTask,
    setStatusMessage,
    workspaceInstanceId,
  ]);

  const rerunStructuredTest = useCallback((result: StructuredTestResult) => {
    runJavaTest({
      name: result.name,
      fullName: result.selector,
      kind: result.selector.includes("#") ? "method" : "class",
      uri: null,
      range: null,
      children: [],
    });
  }, [runJavaTest]);

  const openStructuredTestFailure = useCallback((result: StructuredTestResult) => {
    if (!result.filePath || result.line == null) {
      setStatusMessage("This test result has no source location");
      return;
    }
    const file = openFilesRef.current[activeKey ?? ""];
    const root = file?.ref.kind === "root" ? findRoot(file.ref.rootId) : null;
    if (!root) {
      setStatusMessage("Cannot locate the test result outside an active workspace root");
      return;
    }
    const rawPath = normalizeFsPath(result.filePath);
    const relativePath = rawPath.startsWith("/") || /^[A-Za-z]:\//.test(rawPath)
      ? null
      : rawPath.replace(/^\/+/, "");
    if (relativePath?.split("/").some((segment) => segment === "..")) {
      setStatusMessage(`Test source is outside the workspace: ${result.filePath}`);
      return;
    }
    const absolute = rawPath.startsWith("/") || /^[A-Za-z]:\//.test(rawPath)
      ? rawPath
      : absoluteWorkspacePath(root, rawPath);
    const ref = problemPathToRef(absolute);
    if (!ref) {
      setStatusMessage(`Test source is outside the workspace: ${result.filePath}`);
      return;
    }
    const range: LspRange = {
      start: { line: Math.max(0, result.line - 1), character: 0 },
      end: { line: Math.max(0, result.line - 1), character: 0 },
    };
    void openFile(ref).then(() => revealEditorLocation(fileKey(ref), range));
  }, [activeKey, findRoot, openFile, problemPathToRef, revealEditorLocation, setStatusMessage]);

  // M9 debug-test: resolve the test's JUnit launch config (java-test) and start
  // a debug session through the DAP path.
  const debugJavaTest = useCallback((item: JavaTestItem) => {
    const file = openFilesRef.current[activeKey ?? ""];
    if (!file || file.ref.kind !== "root") return;
    const root = findRoot(file.ref.rootId);
    const descriptor = lspDescriptorForFile(file);
    const absolute = absolutePathForOpenFile(file);
    if (!root || !descriptor || !absolute) return;
    void (async () => {
      try {
        setBottomDockTab("debug");
        setBottomDockOpen(true);
        // Make-before-launch: save + build + block on compile errors.
        if (!(await context.prepareJavaLaunchRef.current(root.id, descriptor))) return;
        const launch = await javaTestResolveLaunch(descriptor, item);
        await debugRef.current?.startDebug({
          workspaceId: descriptor.workspaceId,
          rootPath: root.path,
          filePath: absolute,
          cwd: root.path,
          mainClass: launch.mainClass,
          projectName: launch.projectName,
          classPaths: launch.classPaths,
          modulePaths: launch.modulePaths,
          args: launch.args,
          vmArgs: launch.vmArgs,
          serverCommandId: descriptor.serverCommandId ?? null,
          customServerCommand: descriptor.customServerCommand ?? null,
        });
        setBottomDockTab("debug");
        setBottomDockOpen(true);
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    })();
  }, [activeKey, findRoot, lspDescriptorForFile, absolutePathForOpenFile, setBottomDockOpen, setBottomDockTab, setStatusMessage]);
  return {
    discoverActiveJavaTests,
    runJavaTest,
    rerunStructuredTest,
    loadActiveJavaTestResults,
    openStructuredTestFailure,
    debugJavaTest,
    javaTestBuildTool,
    testResultsByRoot,
  };
}
