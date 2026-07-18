import { invoke } from "@tauri-apps/api/core";

export type SdkKind = "java" | "kotlin" | "scala" | "python";
export type SdkOrigin = "manual" | "discovered";
export type SdkStatus = "ready" | "missing" | "invalid";
export type SdkRole = "project" | "launcher" | "tooling" | "compiler";
export type SdkBindingMode = "auto" | "manual";

export interface SdkInstallation {
  id: string;
  kind: SdkKind;
  name: string;
  location: string;
  executables: Record<string, string>;
  version: string | null;
  vendor: string | null;
  architecture: string | null;
  origin: SdkOrigin;
  status: SdkStatus;
  lastError: string | null;
  lastProbedAt: string | null;
}

export interface SdkDefault {
  kind: SdkKind;
  sdkId: string;
}

export interface WorkspaceSdkBinding {
  scopePath: string;
  kind: SdkKind;
  role: SdkRole;
  mode: SdkBindingMode;
  sdkId: string | null;
  updatedAt: string;
}

export interface SdkRegistry {
  schemaVersion: number;
  installations: SdkInstallation[];
  defaults: SdkDefault[];
  bindings: WorkspaceSdkBinding[];
}

export interface SdkProbe {
  kind: SdkKind;
  location: string;
  executables: Record<string, string>;
  version: string | null;
  vendor: string | null;
  architecture: string | null;
  status: SdkStatus;
  error: string | null;
  source: string | null;
}

export interface SaveSdkInstallationRequest {
  id?: string | null;
  kind: SdkKind;
  name?: string | null;
  location: string;
  origin?: SdkOrigin | null;
}

export interface SaveWorkspaceSdkBindingRequest {
  scopePath: string;
  kind: SdkKind;
  role: SdkRole;
  mode: SdkBindingMode;
  sdkId?: string | null;
}

export type SdkConfidence = "high" | "medium" | "low";
export type SdkConstraintPolicy =
  | "any"
  | "exact"
  | "exactMajor"
  | "preferredMajor"
  | "minimum"
  | "range";

export interface SdkVersionConstraint {
  raw: string;
  policy: SdkConstraintPolicy;
  major: number | null;
}

export interface SdkEvidence {
  sourcePath: string;
  key: string;
  value: string;
  confidence: SdkConfidence;
}

export interface SdkRequirement {
  kind: SdkKind;
  role: SdkRole;
  constraint: SdkVersionConstraint | null;
  requiredLocation: string | null;
  managedByBuild: boolean;
  source: string;
  confidence: SdkConfidence;
  evidence: SdkEvidence[];
}

export type ProjectBuildSystem = "maven" | "gradle" | "sbt" | "pyproject" | "standalone";
export type KotlinPlatform =
  | "jvm"
  | "android"
  | "multiplatform"
  | "js"
  | "wasm"
  | "native"
  | "unknown";
export type KotlinCompilerMode = "buildManaged" | "standalone";

export interface KotlinProjectProfile {
  platform: KotlinPlatform;
  compilerMode: KotlinCompilerMode;
  compilerVersion: string | null;
  languageVersion: string | null;
  apiVersion: string | null;
  jvmTarget: string | null;
  javaToolchain: string | null;
  gradleLauncherJavaHome: string | null;
}

export interface ProjectSdkProfile {
  scopePath: string;
  relativePath: string;
  displayName: string;
  buildSystems: ProjectBuildSystem[];
  languages: SdkKind[];
  requirements: SdkRequirement[];
  kotlin: KotlinProjectProfile | null;
}

export interface WorkspaceSdkAnalysis {
  workspaceRoot: string;
  profiles: ProjectSdkProfile[];
  warnings: string[];
}

export type ResolvedSdkSource =
  | "manualBinding"
  | "projectLocation"
  | "autoMatch"
  | "default"
  | "buildManaged"
  | "unresolved";
export type ResolvedSdkStatus =
  | "resolved"
  | "managed"
  | "missing"
  | "invalid"
  | "incompatible"
  | "unresolved";

export interface ResolvedSdk {
  scopePath: string;
  kind: SdkKind;
  role: SdkRole;
  requirement: SdkRequirement;
  installation: SdkInstallation | null;
  source: ResolvedSdkSource;
  status: ResolvedSdkStatus;
  reason: string;
}

export interface WorkspaceSdkResolution {
  analysis: WorkspaceSdkAnalysis;
  resolved: ResolvedSdk[];
}

export function sdkGetRegistry(): Promise<SdkRegistry> {
  return invoke<SdkRegistry>("sdk_get_registry");
}

export function sdkProbeInstallation(kind: SdkKind, location: string): Promise<SdkProbe> {
  return invoke<SdkProbe>("sdk_probe_installation", { kind, location });
}

export function sdkDiscoverInstallations(kinds?: SdkKind[]): Promise<SdkProbe[]> {
  return invoke<SdkProbe[]>("sdk_discover_installations", { kinds: kinds ?? null });
}

export function sdkSaveInstallation(
  request: SaveSdkInstallationRequest,
): Promise<SdkInstallation> {
  return invoke<SdkInstallation>("sdk_save_installation", { request });
}

export function sdkRemoveInstallation(id: string): Promise<void> {
  return invoke<void>("sdk_remove_installation", { id });
}

export function sdkRefreshInstallations(id?: string | null): Promise<SdkInstallation[]> {
  return invoke<SdkInstallation[]>("sdk_refresh_installations", { id: id ?? null });
}

export function sdkSetDefault(kind: SdkKind, sdkId?: string | null): Promise<void> {
  return invoke<void>("sdk_set_default", {
    request: { kind, sdkId: sdkId ?? null },
  });
}

export function sdkSaveWorkspaceBinding(
  request: SaveWorkspaceSdkBindingRequest,
): Promise<WorkspaceSdkBinding> {
  return invoke<WorkspaceSdkBinding>("sdk_save_workspace_binding", { request });
}

export function sdkRemoveWorkspaceBinding(
  scopePath: string,
  kind: SdkKind,
  role: SdkRole,
): Promise<void> {
  return invoke<void>("sdk_remove_workspace_binding", { scopePath, kind, role });
}

export function sdkAnalyzeWorkspace(workspaceRoot: string): Promise<WorkspaceSdkAnalysis> {
  return invoke<WorkspaceSdkAnalysis>("sdk_analyze_workspace", { workspaceRoot });
}

export function sdkResolveWorkspace(workspaceRoot: string): Promise<WorkspaceSdkResolution> {
  return invoke<WorkspaceSdkResolution>("sdk_resolve_workspace", { workspaceRoot });
}
