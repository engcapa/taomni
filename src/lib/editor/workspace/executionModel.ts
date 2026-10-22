/**
 * Structured execution for a Maven/Gradle task: the resolved absolute executable,
 * its arguments, how it was resolved (wrapper/configured/path), and a diagnostic
 * when the tool could not be resolved. Present only for build-tool tasks.
 */
export interface WorkspaceTaskExecution {
  executable: string;
  args: string[];
  source: "wrapper" | "configured" | "path";
  error?: string;
}

/** A temporary environment variable applied only while a workspace task runs. */
export interface WorkspaceTaskEnvironmentVariable {
  value: string;
  mode: "append" | "replace";
}

export type WorkspaceTaskEnvironment = Record<string, WorkspaceTaskEnvironmentVariable>;

export interface WorkspaceTask {
  id: string;
  label: string;
  command: string;
  cwd: string;
  source: string;
  /** Workspace-relative Maven/Gradle module directory when applicable. */
  modulePath?: string;
  execution?: WorkspaceTaskExecution;
  environment?: WorkspaceTaskEnvironment;
}

export type StructuredTestResultStatus = "passed" | "failed" | "skipped" | "error" | "unknown";

export interface StructuredTestResult {
  id: string;
  /** Provider-native class/method selector used for a rerun. */
  selector: string;
  name: string;
  className: string;
  status: StructuredTestResultStatus;
  durationMs: number | null;
  message: string | null;
  details: string | null;
  /** Optional source path supplied by the test provider (not the report path). */
  filePath: string | null;
  line: number | null;
}

export interface StructuredTestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface StructuredTestResults {
  schema: string;
  version: number;
  source: string;
  generatedAt: number;
  results: StructuredTestResult[];
  summary: StructuredTestSummary;
  diagnostics: string[];
}

/** A Java `static void main` entry point with a ready-to-run terminal command. */
export interface JavaRunTarget {
  id: string;
  label: string;
  mainClass: string;
  filePath: string;
  command: string;
  cwd: string;
  buildSystem: "maven" | "gradle" | "source-file";
  modulePath: string;
  /** Structured executable/argv contract. Optional for older browser fixtures and persisted mocks. */
  execution?: WorkspaceTaskExecution;
  environment?: WorkspaceTaskEnvironment;
}

/**
 * Optional per-workspace build-tool executable overrides passed to the task
 * detectors. Empty/omitted entries fall back to project wrapper then PATH.
 */
export interface WorkspaceToolConfig {
  maven?: string;
  gradle?: string;
  cargo?: string;
  go?: string;
  node?: string;
  npm?: string;
  pnpm?: string;
  yarn?: string;
  python?: string;
  uv?: string;
  poetry?: string;
  cmake?: string;
  dotnet?: string;
  sbt?: string;
  swift?: string;
  lldbDap?: string;
  delve?: string;
  debugpy?: string;
  jsDebug?: string;
  netcoredbg?: string;
  /** Explicit JVM options applied to Maven `exec:java` through MAVEN_OPTS. */
  mavenJvmArgs?: string[];
  /** Auto-inherit safe runtime options from Maven test plugin `argLine`. */
  inheritMavenArgLine?: boolean;
}

export interface ExecutionCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  display: string;
  source: "wrapper" | "configured" | "path";
  error?: string;
}

export interface ExecutionToolProbe {
  id: string;
  label: string;
  state: "available" | "missing";
  executable?: string;
  source?: "wrapper" | "configured" | "path";
  installHint: string;
}

export interface ExecutionProjectModel {
  id: string;
  provider: string;
  root: string;
  manifest: string;
  module: string;
  /** Stable module identity. Optional only for persisted/browser fixtures from before v4.23. */
  moduleId?: string;
  languages: string[];
  languageLevel?: string;
  toolchain: string;
  diagnostics: string[];
}

export interface ExecutionModuleModel {
  id: string;
  projectId: string;
  name: string;
  root: string;
  manifest: string;
  languageLevel?: string;
  sourceSetIds: string[];
  parentModuleId?: string;
  childModuleIds?: string[];
  moduleDependencies?: string[];
  diagnostics: string[];
}

export interface ExecutionSourceSetModel {
  id: string;
  projectId: string;
  moduleId: string;
  name: string;
  kind: "production" | "test" | "generated" | string;
  roots: string[];
  generated: boolean;
  languageLevel?: string;
}

export interface ExecutionCompileArtifact {
  id: string;
  projectId: string;
  moduleId: string;
  targetId: string;
  kind: string;
  path?: string;
  resolution: "blocked" | "pending-provider-output" | "resolved" | string;
  source: string;
  diagnostic?: string;
}

export interface ExecutionBuildTarget {
  id: string;
  projectId: string;
  /** Stable module identity. Optional only for persisted/browser fixtures from before v4.23. */
  moduleId?: string;
  label: string;
  kind: "configure" | "restore" | "build" | "clean" | "check" | "test";
  command: ExecutionCommand;
  dependsOn: string[];
  /** Declared compile artifacts produced by this target. */
  artifactIds?: string[];
}

export interface ExecutionRunConfiguration {
  id: string;
  projectId: string;
  label: string;
  kind: string;
  command: ExecutionCommand;
  sourceFile?: string;
  preLaunchTargets: string[];
  debugConfigurationId?: string;
  /** User-configured VM/runtime options layered over the detected target. */
  runtimeOptions?: string[];
  /** Optional dotenv file loaded immediately before launch. */
  envFile?: string;
  /** Original detected configuration for a persisted named copy. */
  baseConfigurationId?: string;
  /** Provider-specific placement for user program arguments. */
  argumentStrategy?: "append" | "maven-exec" | "gradle-javaexec";
  /** Preserve append semantics for inherited task-scoped environment values. */
  environmentModes?: Record<string, "append" | "replace">;
  /** Provider-discovered, repository-shared, or local configuration origin. */
  configurationSource?: "provider" | "shared" | "local";
  /** Child configuration ids for an IntelliJ-style compound launch. */
  compoundConfigurationIds?: string[];
  /** Run child configurations concurrently when true. */
  compoundParallel?: boolean;
  /** Stop launching subsequent children after the first failure. */
  compoundStopOnFailure?: boolean;
}

export interface ExecutionDebugConfiguration {
  id: string;
  projectId: string;
  label: string;
  adapterId: string;
  request: "launch" | "attach";
  available: boolean;
  diagnostic?: string;
  preLaunchTargets: string[];
  sourceFile?: string;
  launchConfig: Record<string, unknown>;
  /** Optional dotenv file inherited from the associated run configuration. */
  envFile?: string;
  /** Provider-discovered, repository-shared, or local configuration origin. */
  configurationSource?: "provider" | "shared" | "local";
  /** Child debug configuration ids for a compound debug chooser entry. */
  compoundConfigurationIds?: string[];
  compoundParallel?: boolean;
  compoundStopOnFailure?: boolean;
}

export interface WorkspaceExecutionModel {
  projects: ExecutionProjectModel[];
  /** Native execution-model topology; optional for older browser stubs. */
  modules?: ExecutionModuleModel[];
  sourceSets?: ExecutionSourceSetModel[];
  buildTargets: ExecutionBuildTarget[];
  compileArtifacts?: ExecutionCompileArtifact[];
  runConfigurations: ExecutionRunConfiguration[];
  debugConfigurations: ExecutionDebugConfiguration[];
  tools: ExecutionToolProbe[];
  /** Non-fatal provider or repository-shared configuration validation errors. */
  diagnostics?: string[];
}

/** A source-grouped bucket of tasks for the Build panel task tree (M7 F-2). */
export interface WorkspaceTaskGroup {
  source: string;
  tasks: WorkspaceTask[];
}

/** A resolved dependency-tree node (Maven / Gradle) for the Build panel (M7 F-1). */
export interface DependencyNode {
  group: string;
  artifact: string;
  version: string;
  scope: string;
  /** Version-arbitration note (Gradle `-> x`, Maven verbose conflict), when any. */
  conflict: string | null;
  children: DependencyNode[];
}
