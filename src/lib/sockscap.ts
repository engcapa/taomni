// Sockscap IPC layer (plan §12). TypeScript types mirror the Rust serde
// output (camelCase / kebab-case tags) and thin wrappers call the Tauri
// commands. See src-tauri/src/sockscap for the backend. No secrets cross this
// boundary — egress credentials stay in the Vault on the Rust side.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SockscapAction = "direct" | "proxy" | "block";
export type SockscapProtocol = "tcp" | "udp" | "icmp" | "other";
export type SockscapScope = "global" | "applications" | "runtime-processes";
export type EgressKind = "proxy-session" | "ssh-jump";
export type EgressFailureAction = "fail-open" | "fail-closed";
export type DnsMode = "system-capture" | "virtual-dns" | "strict-proxy";
export type UdpPolicy = "proxy-if-supported" | "direct" | "block";
export type LocalNetworkPolicy = "direct" | "by-rule" | "block";
export type CaptureSupport = "supported" | "requires-setup" | "degraded" | "unsupported";
export type EngineStateName =
  | "disabled"
  | "preparing"
  | "active"
  | "degraded"
  | "stopping"
  | "recovery-required";

export type AppSelector =
  | { kind: "windows-executable"; value: string }
  | { kind: "macos-signing-identity"; value: string }
  | { kind: "macos-app-path"; value: string }
  | { kind: "linux-path"; value: string }
  | { kind: "linux-cgroup"; value: string };

export interface RuntimeProcessSelector {
  pid: number;
  processStartTime: string;
  label?: string | null;
}

export interface SshPoolOptions {
  maxControlConnections: number;
  maxChannelsPerControl: number;
  keepaliveSecs: number;
  connectTimeoutSecs: number;
}

export interface StatsPrivacy {
  retainDomainAggregates: boolean;
  domainRetentionDays: number;
  ephemeralOnly: boolean;
}

export interface RoutingProfile {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  scope: SockscapScope;
  appSelectors: AppSelector[];
  runtimeProcesses: RuntimeProcessSelector[];
  includeChildren: boolean;
  egressKind: EgressKind;
  egressRefId: string;
  egressFailureAction: EgressFailureAction;
  ruleSourceIds: string[];
  defaultAction: SockscapAction;
  dnsMode: DnsMode;
  unknownDomainAction: SockscapAction;
  udpPolicy: UdpPolicy;
  localNetworkPolicy: LocalNetworkPolicy;
  sshPoolOptions?: SshPoolOptions | null;
  statsPrivacy: StatsPrivacy;
}

export type RuleSourceKind =
  | "gfwlist-official"
  | "custom-url"
  | "local-auto-proxy"
  | "local-domain-list";

export interface RuleSource {
  id: string;
  name: string;
  kind: RuleSourceKind;
  urls: string[];
  localPath?: string | null;
  enabled: boolean;
  minRefreshSecs: number;
}

export type RuleDirection = "proxy" | "direct" | "block";

export type RulePattern =
  | { type: "domain-suffix"; value: string }
  | { type: "domain-exact"; value: string }
  | { type: "ip"; value: string }
  | { type: "cidr"; value: string };

export interface CustomRule {
  id: string;
  order: number;
  pattern: RulePattern;
  action: RuleDirection;
  note?: string | null;
  enabled: boolean;
}

export interface Capabilities {
  platform: string;
  globalCapture: CaptureSupport;
  appCapture: CaptureSupport;
  pidCapture: CaptureSupport;
  childFollow: boolean;
  trayLeftClickToggle: boolean;
  requiresPrivilege: boolean;
  notes: string[];
}

export interface EngineState {
  state: EngineStateName;
  detail?: string | null;
}

export interface SockscapStatus {
  state: EngineState;
  capabilities: Capabilities;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  /** Best-effort absolute path (often empty without elevation). */
  path?: string | null;
  /** Opaque start-time token for PID-reuse protection (plan §16.4-17). */
  processStartTime?: string | null;
}

export interface EgressSession {
  id: string;
  name: string;
  kind: "ssh" | "proxy";
}

export interface CompiledStatsView {
  totalLines: number;
  domainRules: number;
  exceptionRules: number;
  ipRules: number;
  unsupported: number;
}

export interface RuleSourceMeta {
  stats?: CompiledStatsView | null;
  sha256?: string | null;
  mirrorUrl?: string | null;
  lastGoodAt?: number | null;
  lastError?: string | null;
  unsupportedExamples: string[];
}

export interface TrafficTotals {
  bytesUp: number;
  bytesDown: number;
  connections: number;
  errors: number;
  direct: number;
  proxy: number;
  block: number;
}

export interface StatsSnapshot {
  bytesUp: number;
  bytesDown: number;
  connections: number;
  direct: number;
  proxy: number;
  block: number;
  errors: number;
}

export interface TestTargetInput {
  app?: {
    windowsExe?: string;
    macosSigningId?: string;
    macosAppPath?: string;
    linuxPath?: string;
    linuxCgroup?: string;
    pid?: number;
    processStartTime?: string;
  };
  host?: string;
  ip?: string;
  port: number;
  protocol?: SockscapProtocol;
}

export interface TestTargetResult {
  profileId: string | null;
  action: SockscapAction;
  reason: string;
  hostnameSource: string;
  matchedSourceId: string | null;
  matchedPattern: string | null;
  note: string | null;
}

/* --------------------------------- commands -------------------------------- */

export const sockscap = {
  capabilities: () => invoke<Capabilities>("sockscap_capabilities"),
  status: () => invoke<SockscapStatus>("sockscap_status"),

  listProfiles: () => invoke<RoutingProfile[]>("sockscap_list_profiles"),
  upsertProfile: (profile: RoutingProfile) =>
    invoke<void>("sockscap_upsert_profile", { profile }),
  deleteProfile: (id: string) => invoke<void>("sockscap_delete_profile", { id }),

  getCustomRules: (profileId: string) =>
    invoke<CustomRule[]>("sockscap_get_custom_rules", { profileId }),
  setCustomRules: (profileId: string, rules: CustomRule[]) =>
    invoke<void>("sockscap_set_custom_rules", { profileId, rules }),

  listRuleSources: () => invoke<RuleSource[]>("sockscap_list_rule_sources"),
  upsertRuleSource: (source: RuleSource) =>
    invoke<void>("sockscap_upsert_rule_source", { source }),
  deleteRuleSource: (id: string) => invoke<void>("sockscap_delete_rule_source", { id }),
  refreshRuleSource: (id: string) =>
    invoke<RuleSourceMeta>("sockscap_refresh_rule_source", { id }),
  importRuleSource: (id: string, content: string) =>
    invoke<RuleSourceMeta>("sockscap_import_rule_source", { id, content }),

  testTarget: (input: TestTargetInput) =>
    invoke<TestTargetResult>("sockscap_test_target", { input }),

  start: () => invoke<EngineState>("sockscap_start"),
  stop: () => invoke<EngineState>("sockscap_stop"),
  recover: () => invoke<EngineState>("sockscap_recover"),

  statsSnapshot: () => invoke<TrafficTotals>("sockscap_stats_snapshot"),
  liveStats: () => invoke<StatsSnapshot>("sockscap_live_stats"),
  clearStats: () => invoke<void>("sockscap_clear_stats"),

  listProcesses: () => invoke<ProcessInfo[]>("sockscap_list_processes"),
  listEgressSessions: () => invoke<EgressSession[]>("sockscap_list_egress_sessions"),
};

/* ---------------------------------- events --------------------------------- */

export const SOCKSCAP_EVENTS = {
  status: "sockscap://status",
  trafficSummary: "sockscap://traffic-summary",
  profileHealth: "sockscap://profile-health",
  egressHealth: "sockscap://egress-health",
  alert: "sockscap://alert",
} as const;

export function onSockscapStatus(cb: (s: EngineState) => void): Promise<UnlistenFn> {
  return listen<EngineState>(SOCKSCAP_EVENTS.status, (e) => cb(e.payload));
}

export function onSockscapTraffic(cb: (s: StatsSnapshot) => void): Promise<UnlistenFn> {
  return listen<StatsSnapshot>(SOCKSCAP_EVENTS.trafficSummary, (e) => cb(e.payload));
}

export function onSockscapAlert(
  cb: (a: { level: string; message: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ level: string; message: string }>(SOCKSCAP_EVENTS.alert, (e) => cb(e.payload));
}

/** True when the given capability level allows a scope to be selected now. */
export function isCaptureUsable(support: CaptureSupport): boolean {
  return support === "supported" || support === "requires-setup";
}

