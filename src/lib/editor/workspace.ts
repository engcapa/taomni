export {
  type WorkspaceCompactChain,
  type WorkspaceEntry,
  type WorkspaceEntryType,
  type WorkspaceFile,
  type WorkspaceGitRoot,
  type WorkspaceGitRootCandidate,
  type WorkspaceTreeLoadResult,
} from "./workspace/model";

export { workspaceCompactChain, workspaceDetectGitRoots, workspaceListDir, workspaceListFilesRecursive } from "./workspace/tree";

export {
  type DependencyNode,
  type ExecutionBuildTarget,
  type ExecutionCommand,
  type ExecutionCompileArtifact,
  type ExecutionDebugConfiguration,
  type ExecutionModuleModel,
  type ExecutionProjectModel,
  type ExecutionRunConfiguration,
  type ExecutionSourceSetModel,
  type ExecutionToolProbe,
  type JavaRunTarget,
  type StructuredTestResult,
  type StructuredTestResultStatus,
  type StructuredTestResults,
  type StructuredTestSummary,
  type WorkspaceExecutionModel,
  type WorkspaceTask,
  type WorkspaceTaskEnvironment,
  type WorkspaceTaskEnvironmentVariable,
  type WorkspaceTaskExecution,
  type WorkspaceTaskGroup,
  type WorkspaceToolConfig,
} from "./workspace/executionModel";

export {
  workspaceDependencyTree,
  workspaceDetectTasks,
  workspaceExecutionModel,
  workspaceJavaRunTarget,
  workspaceJavaRunTargets,
  workspaceTaskTree,
  workspaceTestResults,
} from "./workspace/execution";

export { workspaceReadFile, workspaceReadFileWithEncoding, workspaceReadLooseFile, workspaceReadLooseFileWithEncoding } from "./workspace/reading";

export {
  WorkspaceHashMismatchError,
  WorkspaceWriteError,
  isWorkspaceHashMismatchError,
  parseWorkspaceWriteError,
  type WorkspaceWriteAck,
  type WorkspaceWriteEffect,
  type WorkspaceWriteErrorData,
  type WorkspaceWriteErrorKind,
} from "./workspace/writeModel";

export { workspaceWriteFile, workspaceWriteFileEncoded, workspaceWriteLooseFile, workspaceWriteLooseFileEncoded } from "./workspace/writing";

export {
  workspaceApplyResourceOperation,
  workspaceCreateDir,
  workspaceCreateFile,
  workspaceDeletePath,
  workspaceRenamePath,
  type WorkspaceResourceOperation,
  type WorkspaceResourceOperationResult,
} from "./workspace/resources";
