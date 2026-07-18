/**
 * Sockscap frontend IPC helpers (Phase 3).
 *
 * Mirrors design plan §12 command surface. Browser mode uses stubs in
 * `src/stubs/tauri-core.ts`; desktop mode hits the Rust commands.
 */

import { invoke } from "@tauri-apps/api/core";

export type EngineState =
  | "disabled"
  | "preparing"
  | "active"
  | "degraded"
  | "stopping"
  | "recovery_required"
  | "user_action_required";

export type ProfileScope = "global" | "applications" | "runtime_processes";
export type RouteAction = "direct" | "proxy" | "block";
export type EgressKind = "proxy_session" | "ssh_jump";
export type SupportLevel =
  | "supported"
  | "degraded"
  | "unsupported"
  | "not_implemented"
  | "unknown";

export interface RoutingProfileDraft {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  scope: ProfileScope;
  appSelectors: string[];
  includeChildren: boolean;
  egressKind?: EgressKind | null;
  egressRefId?: string | null;
  egressFailureAction?: "fail_open" | "fail_closed";
  defaultAction: RouteAction;
  dnsMode?: "system_capture" | "virtual_dns" | "strict_proxy";
  unknownDomainAction?: RouteAction;
  udpPolicy?: "proxy_if_supported" | "direct" | "block";
}

export interface CapabilityItem {
  id: string;
  name: string;
  level: SupportLevel;
  detail: string;
  requiredForStart: boolean;
}

export interface CapabilitiesReport {
  platform: string;
  items: CapabilityItem[];
  canStartGlobal: boolean;
  canStartAppGroup: boolean;
  canAttachPid: boolean;
  summary: string;
  captureImplemented: boolean;
}

export interface EngineStatus {
  state: EngineState;
  message: string;
  activeProfileIds: string[];
  lastError?: string | null;
  recoveryRequired: boolean;
  captureActive: boolean;
}

export interface PreflightFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface PreflightReport {
  ok: boolean;
  capabilities: CapabilitiesReport;
  conflicts: Array<{ profileA: string; profileB: string; reason: string }>;
  findings: PreflightFinding[];
  suggestedState: EngineState;
}

export interface TestTargetRequest {
  appIdentity?: string | null;
  pid?: number | null;
  hostname?: string | null;
  ip?: string | null;
  port: number;
  protocol: string;
  hostnameSource?: string | null;
  hardBypass?: boolean;
  profiles: RoutingProfileDraft[];
}

export interface TestTargetResult {
  selectedProfileId?: string | null;
  selectedProfileName?: string | null;
  selectionReason: string;
  decision?: {
    action: RouteAction;
    matchedRuleOriginal?: string | null;
    matchedRuleSourceId?: string | null;
    matchedStage: string;
    hostnameSource: string;
    profileId: string;
  } | null;
  conflicts: Array<{ profileA: string; profileB: string; reason: string }>;
  notes: string[];
}

export async function sockscapOpenWindow(): Promise<void> {
  return invoke("sockscap_open_window");
}

export async function sockscapCapabilities(): Promise<CapabilitiesReport> {
  return invoke<CapabilitiesReport>("sockscap_capabilities");
}

export async function sockscapStatus(): Promise<EngineStatus> {
  return invoke<EngineStatus>("sockscap_status");
}

export async function sockscapPreflight(
  profiles?: RoutingProfileDraft[],
): Promise<PreflightReport> {
  return invoke<PreflightReport>("sockscap_preflight", { profiles: profiles ?? null });
}

export async function sockscapStart(
  profiles?: RoutingProfileDraft[],
): Promise<EngineStatus> {
  return invoke<EngineStatus>("sockscap_start", { profiles: profiles ?? null });
}

export async function sockscapStop(): Promise<EngineStatus> {
  return invoke<EngineStatus>("sockscap_stop");
}

export async function sockscapRecover(): Promise<EngineStatus> {
  return invoke<EngineStatus>("sockscap_recover");
}

export async function sockscapListProfiles(): Promise<RoutingProfileDraft[]> {
  return invoke<RoutingProfileDraft[]>("sockscap_list_profiles");
}

export async function sockscapUpsertProfile(
  profile: RoutingProfileDraft,
): Promise<RoutingProfileDraft> {
  return invoke<RoutingProfileDraft>("sockscap_upsert_profile", { profile });
}

export async function sockscapDeleteProfile(id: string): Promise<void> {
  return invoke("sockscap_delete_profile", { id });
}

export async function sockscapTestTarget(
  request: TestTargetRequest,
): Promise<TestTargetResult> {
  return invoke<TestTargetResult>("sockscap_test_target", { request });
}

export async function sockscapGfwlistOfficialInfo(): Promise<{
  sourceId: string;
  mirrors: string[];
}> {
  return invoke("sockscap_gfwlist_official_info");
}

export async function sockscapCompileRules(
  sourceId: string,
  payload: string,
): Promise<unknown> {
  return invoke("sockscap_compile_rules", { sourceId, payload });
}

export async function sockscapRecoveryJournal(): Promise<{
  marker: string;
  state: string;
  detail?: string | null;
  updatedAt: number;
} | null> {
  return invoke("sockscap_recovery_journal");
}
