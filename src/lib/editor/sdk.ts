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
