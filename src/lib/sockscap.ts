import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { SOCKSCAP_EVENTS } from "./sockscapEvents";

export { SOCKSCAP_EVENTS } from "./sockscapEvents";

// Sockscap IPC is intentionally collected in one module. The Rust command
// boundary uses the same camelCase field names; snake_case values below mirror
// serde enum representations exactly.

export type SockscapPlatform = "windows" | "macos" | "linux" | "unknown";
export type SockscapSupportLevel =
  | "supported"
  | "degraded"
  | "unsupported"
  | "not_implemented"
  | "unknown";
export type SockscapEngineState =
  | "disabled"
  | "preparing"
  | "active"
  | "degraded"
  | "stopping"
  | "recovery_required"
  | "user_action_required";
export type SockscapProfileScope = "global" | "applications" | "runtime_processes";
export type SockscapAppSelectorKind =
  | "executable_path"
  | "macos_signing_identity"
  | "linux_cgroup";
export type SockscapEgressKind = "proxy_session" | "ssh_jump";
export type SockscapRouteAction = "direct" | "proxy" | "block";
export type SockscapEgressFailureAction = "fail_open" | "fail_closed";
export type SockscapDnsMode = "system_capture" | "virtual_dns" | "strict_proxy";
export type SockscapUdpPolicy = "proxy_if_supported" | "direct" | "block";
export type SockscapLocalNetworkAction = "direct" | "rules" | "block";
export type SockscapStatsCollectionMode = "persisted" | "session_only" | "disabled";
export type SockscapCustomRuleKind =
  | "domain_suffix"
  | "domain_exact"
  | "domain_keyword"
  | "ip_cidr";
export type SockscapHostnameSource =
  | "platform_remote_hostname"
  | "fake_ip_dns_map"
  | "tls_sni"
  | "http_host"
  | "ip_only"
  | "unknown";

export interface SockscapCapabilityItem {
  id: string;
  name: string;
  level: SockscapSupportLevel;
  detail: string;
  requiredForStart: boolean;
}

export interface SockscapCapabilitiesReport {
  platform: SockscapPlatform;
  items: SockscapCapabilityItem[];
  canStartGlobal: boolean;
  canStartAppGroup: boolean;
  canAttachPid: boolean;
  summary: string;
  captureImplemented: boolean;
}

export interface SockscapEngineStatus {
  state: SockscapEngineState;
  message: string;
  activeProfileIds: string[];
  lastError: string | null;
  recoveryRequired: boolean;
  captureActive: boolean;
}

export interface SockscapAppSelector {
  kind: SockscapAppSelectorKind;
  value: string;
}

export interface SockscapRuntimeProcessSelector {
  pid: number;
  processStartTime: number;
}

export interface SockscapSshPoolOptions {
  maxControlConnections: number;
  maxChannelsPerConnection: number;
  keepaliveSeconds: number;
  connectTimeoutSeconds: number;
}

export interface SockscapLocalNetworkPolicy {
  lanAction: SockscapLocalNetworkAction;
}

export interface SockscapStatsPrivacy {
  collectionMode: SockscapStatsCollectionMode;
  minuteRetentionDays: number;
  hourlyRetentionDays: number;
  domainAggregationEnabled: boolean;
  domainRetentionDays: number;
}

export interface SockscapCustomRuleDraft {
  id: string;
  enabled: boolean;
  action: SockscapRouteAction;
  kind: SockscapCustomRuleKind;
  pattern: string;
}

export interface SockscapRoutingProfileDraft {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  scope: SockscapProfileScope;
  appSelectors: SockscapAppSelector[];
  runtimeProcesses: SockscapRuntimeProcessSelector[];
  includeChildren: boolean;
  egressKind: SockscapEgressKind | null;
  egressRefId: string | null;
  egressFailureAction: SockscapEgressFailureAction;
  sshPoolOptions: SockscapSshPoolOptions;
  ruleSourceIds: string[];
  customRules: SockscapCustomRuleDraft[];
  defaultAction: SockscapRouteAction;
  dnsMode: SockscapDnsMode;
  unknownDomainAction: SockscapRouteAction;
  udpPolicy: SockscapUdpPolicy;
  localNetworkPolicy: SockscapLocalNetworkPolicy;
  statsPrivacy: SockscapStatsPrivacy;
}

export interface SockscapPersistedRoutingProfile {
  profile: SockscapRoutingProfileDraft;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SockscapProfileConflict {
  profileA: string;
  profileB: string;
  reason: string;
}

export type SockscapPreflightSeverity = "error" | "warning" | "info";

export interface SockscapPreflightFinding {
  code: string;
  severity: SockscapPreflightSeverity;
  message: string;
}

export interface SockscapPreflightReport {
  ok: boolean;
  capabilities: SockscapCapabilitiesReport;
  conflicts: SockscapProfileConflict[];
  findings: SockscapPreflightFinding[];
  suggestedState: SockscapEngineState;
}

export interface SockscapProcessSummary {
  pid: number;
  parentPid: number | null;
  name: string;
  executablePath: string | null;
  processStartTime: number;
  selectable: boolean;
  rememberable: boolean;
  issueCode: string | null;
}

export interface SockscapProcessCatalog {
  processes: SockscapProcessSummary[];
  truncated: boolean;
  maxRows: number;
}

export type SockscapEgressProtocol = "socks5" | "http_connect" | "ssh_jump";
export type SockscapEgressAuthKind =
  | "none"
  | "username_password"
  | "password"
  | "private_key"
  | "agent";
export type SockscapEgressAvailability = "ready" | "user_action_required" | "invalid";

export interface SockscapEgressIssue {
  code: string;
  message: string;
  userActionRequired: boolean;
}

export interface SockscapEgressSessionSummary {
  id: string;
  name: string;
  kind: SockscapEgressKind;
  protocol: SockscapEgressProtocol;
  endpointHost: string;
  endpointPort: number;
  authKind: SockscapEgressAuthKind;
  remoteDns: boolean;
  tcpOnly: boolean;
  availability: SockscapEgressAvailability;
  issue: SockscapEgressIssue | null;
}

export interface SockscapTestEgressRequest {
  sessionId: string;
  targetHost: string;
  targetPort: number;
  timeoutMillis: number;
  interactive: boolean;
  sshPoolOptions: SockscapSshPoolOptions;
}

export interface SockscapEgressMetadata {
  connector: string;
  remoteDns: boolean;
  tcpOnly: boolean;
  detail: string;
}

export type SockscapSshPoolHealthState =
  | "disconnected"
  | "connecting"
  | "healthy"
  | "degraded"
  | "user_action_required"
  | "stopped";

export interface SockscapSshPoolSnapshot {
  state: SockscapSshPoolHealthState;
  activeControlConnections: number;
  activeChannels: number;
  lastHandshakeRttMs: number | null;
  channelOpenErrors: number;
  reconnects: number;
  bytesUp: number;
  bytesDown: number;
  lastErrorCode: string | null;
  lastHostKeyStatus: string | null;
}

export interface SockscapTestEgressResult {
  ok: boolean;
  summary: SockscapEgressSessionSummary;
  elapsedMillis: number;
  metadata: SockscapEgressMetadata | null;
  issue: SockscapEgressIssue | null;
  sshPool: SockscapSshPoolSnapshot | null;
}

export type SockscapRuleSourceKind = "gfwlist_official" | "custom_url" | "local_file";

export interface SockscapRuleSourceDraft {
  id: string;
  name: string;
  enabled: boolean;
  kind: SockscapRuleSourceKind;
  url: string | null;
  refreshIntervalSeconds: number;
}

export interface SockscapPersistedRuleSource {
  source: SockscapRuleSourceDraft;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SockscapParseStats {
  totalLines: number;
  proxyRules: number;
  directRules: number;
  unsupported: number;
  ignoredComments: number;
}

export interface SockscapRuleSourceState {
  sourceId: string;
  kind: SockscapRuleSourceKind;
  url: string | null;
  /** Rust deliberately redacts the internal cache location at the IPC edge. */
  lastGoodPath: null;
  lastSuccessUnix: number | null;
  lastMirror: string | null;
  lastSha256: string | null;
  etag: string | null;
  lastModified: string | null;
  refreshAfterUnix: number | null;
  lastError: string | null;
  parseStats: SockscapParseStats | null;
}

export interface SockscapRuleSourceView {
  record: SockscapPersistedRuleSource;
  state: SockscapRuleSourceState | null;
}

export type SockscapRuleKind = "domain_suffix" | "domain_exact" | "ip_cidr" | "domain_keyword";

export interface SockscapCompiledRule {
  action: SockscapRouteAction;
  kind: SockscapRuleKind;
  pattern: string;
  original: string;
  sourceId: string;
}

export interface SockscapUnsupportedRule {
  original: string;
  reason: string;
}

export interface SockscapParseReport {
  proxyRules: SockscapCompiledRule[];
  directRules: SockscapCompiledRule[];
  unsupported: SockscapUnsupportedRule[];
  ignoredComments: number;
  totalLines: number;
}

export interface SockscapRefreshOutcome {
  ok: boolean;
  usedLastGood: boolean;
  notModified: boolean;
  mirror: string | null;
  sha256: string | null;
  parseStats: SockscapParseStats | null;
  error: string | null;
  report: SockscapParseReport | null;
}

/** Public request only; Rust injects saved profiles and compiled matchers. */
export interface SockscapTestTargetRequest {
  appIdentity: string | null;
  appSelectorKind: SockscapAppSelectorKind | null;
  pid: number | null;
  processStartTime: number | null;
  hostname: string | null;
  ip: string | null;
  port: number;
  protocol: "tcp" | "udp" | "quic";
  hostnameSource: SockscapHostnameSource | null;
  hardBypass: boolean;
}

export interface SockscapPolicyDecision {
  action: SockscapRouteAction;
  matchedRuleOriginal: string | null;
  matchedRuleSourceId: string | null;
  matchedStage: string;
  hostnameSource: SockscapHostnameSource;
  profileId: string;
}

export interface SockscapTestTargetResult {
  selectedProfileId: string | null;
  selectedProfileName: string | null;
  selectionReason: string;
  decision: SockscapPolicyDecision | null;
  conflicts: SockscapProfileConflict[];
  notes: string[];
}

export interface SockscapStatsSnapshotQuery {
  fromUnix: number;
  toUnix: number;
  includeDomains: boolean;
  limit: number;
}

export interface SockscapStatsTotals {
  bytesUp: number;
  bytesDown: number;
  connections: number;
  errors: number;
  directConnections: number;
  proxyConnections: number;
  blockedConnections: number;
  unknownHostnameConnections: number;
  connectMillisTotal: number;
}

export interface SockscapStatsSeriesPoint {
  bucketStart: number;
  resolutionSeconds: number;
  bytesUp: number;
  bytesDown: number;
  connections: number;
  errors: number;
  directConnections: number;
  proxyConnections: number;
  blockedConnections: number;
}

export interface SockscapStatsTopEntry {
  key: string;
  bytesUp: number;
  bytesDown: number;
  connections: number;
}

export interface SockscapEgressHealthPoint {
  bucketStart: number;
  profileId: string;
  egressKind: string;
  controlState: string;
  activeControlsMax: number;
  activeChannelsMax: number;
  channelErrors: number;
  reconnects: number;
  bytesUp: number;
  bytesDown: number;
  handshakeMillisTotal: number;
  handshakeSamples: number;
  hostKeyState: string | null;
  lastErrorCode: string | null;
}

export interface SockscapStatsSnapshot {
  generatedAt: number;
  fromUnix: number;
  toUnix: number;
  totals: SockscapStatsTotals;
  series: SockscapStatsSeriesPoint[];
  topApplications: SockscapStatsTopEntry[];
  topDomains: SockscapStatsTopEntry[];
  egressHealth: SockscapEgressHealthPoint[];
}

export interface SockscapClearStatsResult {
  removedRows: number;
}

export interface SockscapGfwlistOfficialInfo {
  sourceId: string;
  mirrors: string[];
}

export interface SockscapTrafficSummaryEvent {
  generatedAtUnix: number;
  totals: SockscapStatsTotals;
  cleared: boolean;
}

export interface SockscapProfileHealthEvent {
  profileId: string;
  enabled: boolean;
  egress: SockscapEgressSessionSummary | null;
  issue: SockscapEgressIssue | null;
}

export interface SockscapAlertEvent {
  code: string;
  message: string;
  severity: string;
  createdAtUnix: number;
}

export function sockscapCapabilities(): Promise<SockscapCapabilitiesReport> {
  return invoke("sockscap_capabilities", {});
}

export function sockscapStatus(): Promise<SockscapEngineStatus> {
  return invoke("sockscap_status", {});
}

export function sockscapPreflight(): Promise<SockscapPreflightReport> {
  return invoke("sockscap_preflight", {});
}

export function sockscapListProfiles(): Promise<SockscapPersistedRoutingProfile[]> {
  return invoke("sockscap_list_profiles", {});
}

export function sockscapUpsertProfile(
  profile: SockscapRoutingProfileDraft,
  expectedRevision: number | null = null,
): Promise<SockscapPersistedRoutingProfile> {
  return invoke("sockscap_upsert_profile", { profile, expectedRevision });
}

export function sockscapDeleteProfile(profileId: string, expectedRevision: number | null = null): Promise<void> {
  return invoke("sockscap_delete_profile", { profileId, expectedRevision });
}

export function sockscapListProcesses(): Promise<SockscapProcessCatalog> {
  return invoke("sockscap_list_processes", {});
}

export function sockscapStart(): Promise<SockscapEngineStatus> {
  return invoke("sockscap_start", {});
}

export function sockscapStop(): Promise<SockscapEngineStatus> {
  return invoke("sockscap_stop", {});
}

export function sockscapRecover(): Promise<SockscapEngineStatus> {
  return invoke("sockscap_recover", {});
}

export function sockscapOpenWindow(): Promise<void> {
  return invoke("sockscap_open_window", {});
}

export type SockscapWindowCloseOutcome = "hidden" | "closed";

export function sockscapCloseWindow(): Promise<SockscapWindowCloseOutcome> {
  return invoke("sockscap_close_window", {});
}

export function sockscapListEgressSessions(): Promise<SockscapEgressSessionSummary[]> {
  return invoke("sockscap_list_egress_sessions", {});
}

export function sockscapTestEgress(request: SockscapTestEgressRequest): Promise<SockscapTestEgressResult> {
  return invoke("sockscap_test_egress", { request });
}

export function sockscapTestTarget(request: SockscapTestTargetRequest): Promise<SockscapTestTargetResult> {
  return invoke("sockscap_test_target", { request });
}

export function sockscapCompileRules(sourceId: string, payload: string): Promise<SockscapParseReport> {
  return invoke("sockscap_compile_rules", { sourceId, payload });
}

export function sockscapListRuleSources(): Promise<SockscapRuleSourceView[]> {
  return invoke("sockscap_list_rule_sources", {});
}

export function sockscapUpsertRuleSource(
  source: SockscapRuleSourceDraft,
  expectedRevision: number | null = null,
): Promise<SockscapPersistedRuleSource> {
  return invoke("sockscap_upsert_rule_source", { source, expectedRevision });
}

export function sockscapDeleteRuleSource(sourceId: string, expectedRevision: number | null = null): Promise<void> {
  return invoke("sockscap_delete_rule_source", { sourceId, expectedRevision });
}

export function sockscapImportRuleSource(sourceId: string, payload: string): Promise<SockscapRefreshOutcome> {
  return invoke("sockscap_import_rule_source", { sourceId, payload });
}

export function sockscapRefreshRuleSource(sourceId: string): Promise<SockscapRefreshOutcome> {
  return invoke("sockscap_refresh_rule_source", { sourceId });
}

export function sockscapStatsSnapshot(query: SockscapStatsSnapshotQuery): Promise<SockscapStatsSnapshot> {
  return invoke("sockscap_stats_snapshot", { query });
}

export function sockscapClearStats(): Promise<SockscapClearStatsResult> {
  return invoke("sockscap_clear_stats", {});
}

export function sockscapGfwlistOfficialInfo(): Promise<SockscapGfwlistOfficialInfo> {
  return invoke("sockscap_gfwlist_official_info", {});
}

function listenPayload<T>(eventName: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(eventName, (event) => handler(event.payload));
}

export function listenSockscapStatus(handler: (payload: SockscapEngineStatus) => void): Promise<UnlistenFn> {
  return listenPayload(SOCKSCAP_EVENTS.status, handler);
}

export function listenSockscapTrafficSummary(
  handler: (payload: SockscapTrafficSummaryEvent) => void,
): Promise<UnlistenFn> {
  return listenPayload(SOCKSCAP_EVENTS.trafficSummary, handler);
}

export function listenSockscapProfileHealth(
  handler: (payload: SockscapProfileHealthEvent) => void,
): Promise<UnlistenFn> {
  return listenPayload(SOCKSCAP_EVENTS.profileHealth, handler);
}

export function listenSockscapEgressHealth(
  handler: (payload: SockscapTestEgressResult) => void,
): Promise<UnlistenFn> {
  return listenPayload(SOCKSCAP_EVENTS.egressHealth, handler);
}

export function listenSockscapAlert(handler: (payload: SockscapAlertEvent) => void): Promise<UnlistenFn> {
  return listenPayload(SOCKSCAP_EVENTS.alert, handler);
}

export interface SockscapIpcContractFixture {
  capabilities: SockscapCapabilitiesReport;
  status: SockscapEngineStatus;
  preflight: SockscapPreflightReport;
  profile: SockscapPersistedRoutingProfile;
  processCatalog: SockscapProcessCatalog;
  egressSession: SockscapEgressSessionSummary;
  egressTest: SockscapTestEgressResult;
  ruleSource: SockscapRuleSourceView;
  refreshOutcome: SockscapRefreshOutcome;
  targetResult: SockscapTestTargetResult;
  stats: SockscapStatsSnapshot;
  events: {
    trafficSummary: SockscapTrafficSummaryEvent;
    profileHealth: SockscapProfileHealthEvent;
    egressHealth: SockscapTestEgressResult;
    alert: SockscapAlertEvent;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime smoke check used by the shared Rust/TypeScript contract fixture. */
export function isSockscapIpcContractFixture(value: unknown): value is SockscapIpcContractFixture {
  if (!isRecord(value)) return false;
  const capabilities = value.capabilities;
  const status = value.status;
  const profile = value.profile;
  const processCatalog = value.processCatalog;
  const egress = value.egressSession;
  const ruleSource = value.ruleSource;
  const stats = value.stats;
  const events = value.events;
  return (
    isRecord(capabilities)
    && typeof capabilities.captureImplemented === "boolean"
    && Array.isArray(capabilities.items)
    && isRecord(status)
    && typeof status.recoveryRequired === "boolean"
    && Array.isArray(status.activeProfileIds)
    && isRecord(profile)
    && isRecord(profile.profile)
    && Array.isArray(profile.profile.appSelectors)
    && isRecord(processCatalog)
    && Array.isArray(processCatalog.processes)
    && isRecord(egress)
    && typeof egress.endpointPort === "number"
    && !("username" in egress)
    && !("password" in egress)
    && isRecord(ruleSource)
    && isRecord(ruleSource.record)
    && (!isRecord(ruleSource.state) || ruleSource.state.lastGoodPath === null)
    && isRecord(stats)
    && isRecord(stats.totals)
    && Array.isArray(stats.series)
    && isRecord(events)
    && isRecord(events.trafficSummary)
    && isRecord(events.profileHealth)
    && isRecord(events.egressHealth)
    && isRecord(events.alert)
    && typeof events.alert.createdAtUnix === "number"
  );
}
