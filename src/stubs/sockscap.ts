import type {
  SockscapAlertEvent,
  SockscapCapabilitiesReport,
  SockscapClearStatsResult,
  SockscapCompiledRule,
  SockscapEgressIssue,
  SockscapEgressSessionSummary,
  SockscapEngineStatus,
  SockscapParseReport,
  SockscapPersistedRoutingProfile,
  SockscapPersistedRuleSource,
  SockscapPreflightReport,
  SockscapProcessCatalog,
  SockscapProfileConflict,
  SockscapProfileHealthEvent,
  SockscapRefreshOutcome,
  SockscapRoutingProfileDraft,
  SockscapRuleSourceDraft,
  SockscapRuleSourceState,
  SockscapRuleSourceView,
  SockscapStatsSeriesPoint,
  SockscapStatsSnapshot,
  SockscapStatsSnapshotQuery,
  SockscapStatsTotals,
  SockscapTestEgressRequest,
  SockscapTestEgressResult,
  SockscapTestTargetRequest,
  SockscapTestTargetResult,
  SockscapTrafficSummaryEvent,
} from "../lib/sockscap";
import { SOCKSCAP_EVENTS } from "../lib/sockscapEvents";
import { emit } from "./tauri-event";

const STORAGE_KEY = "taomni.stub.sockscap.v1";

export type SockscapStubCapabilityMode = "supported" | "degraded" | "permission_required" | "unsupported";
export type SockscapStubEgressHealth = "healthy" | "degraded" | "user_action_required" | "invalid";
export type SockscapStubTrafficMode = "idle" | "steady" | "burst";

export interface SockscapStubScenario {
  platform: "windows" | "macos" | "linux";
  capabilityMode: SockscapStubCapabilityMode;
  proxyHealth: SockscapStubEgressHealth;
  sshHealth: SockscapStubEgressHealth;
  trafficMode: SockscapStubTrafficMode;
  recoveryRequired: boolean;
}

export interface SockscapStubController {
  configure(patch: Partial<SockscapStubScenario>): Promise<SockscapStubScenario>;
  reset(): Promise<void>;
  snapshot(): SockscapStubScenario;
  emitTraffic(): Promise<SockscapTrafficSummaryEvent | null>;
}

declare global {
  interface Window {
    /** Browser-dev/QA controls; never present in a packaged Tauri build. */
    __TAOMNI_SOCKSCAP_STUB__?: SockscapStubController;
  }
}

interface StubPersistedState {
  scenario: SockscapStubScenario;
  profiles: SockscapPersistedRoutingProfile[];
  ruleSources: SockscapPersistedRuleSource[];
}

interface StubRuntimeState extends StubPersistedState {
  status: SockscapEngineStatus;
  statsTotals: SockscapStatsTotals;
  statsSeries: SockscapStatsSeriesPoint[];
  lastTrafficEmitMillis: number;
  trafficTimer: ReturnType<typeof globalThis.setInterval> | null;
}

export type SockscapStubInvokeResult =
  | { handled: false }
  | { handled: true; value: unknown };

const defaultScenario = (): SockscapStubScenario => ({
  platform: "windows",
  capabilityMode: "supported",
  proxyHealth: "healthy",
  sshHealth: "healthy",
  trafficMode: "steady",
  recoveryRequired: false,
});

const zeroTotals = (): SockscapStatsTotals => ({
  bytesUp: 0,
  bytesDown: 0,
  connections: 0,
  errors: 0,
  directConnections: 0,
  proxyConnections: 0,
  blockedConnections: 0,
  unknownHostnameConnections: 0,
  connectMillisTotal: 0,
});

const disabledStatus = (): SockscapEngineStatus => ({
  state: "disabled",
  message: "Sockscap browser simulation is disabled",
  activeProfileIds: [],
  lastError: null,
  recoveryRequired: false,
  captureActive: false,
});

const nowUnix = (): number => Math.floor(Date.now() / 1000);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeDefaultProfile(): SockscapPersistedRoutingProfile {
  const now = nowUnix();
  return {
    revision: 1,
    createdAt: now,
    updatedAt: now,
    profile: {
      id: "browser-demo",
      name: "Browser demo",
      enabled: true,
      priority: 100,
      scope: "global",
      appSelectors: [],
      runtimeProcesses: [],
      includeChildren: true,
      egressKind: "proxy_session",
      egressRefId: "stub-proxy",
      egressFailureAction: "fail_open",
      sshPoolOptions: {
        maxControlConnections: 2,
        maxChannelsPerConnection: 128,
        keepaliveSeconds: 30,
        connectTimeoutSeconds: 15,
      },
      ruleSourceIds: ["gfwlist-official"],
      customRules: [],
      defaultAction: "proxy",
      dnsMode: "virtual_dns",
      unknownDomainAction: "direct",
      udpPolicy: "block",
      localNetworkPolicy: { lanAction: "direct" },
      statsPrivacy: {
        collectionMode: "session_only",
        minuteRetentionDays: 7,
        hourlyRetentionDays: 90,
        domainAggregationEnabled: false,
        domainRetentionDays: 7,
      },
    },
  };
}

function makeDefaultRuleSource(): SockscapPersistedRuleSource {
  const now = nowUnix();
  return {
    revision: 1,
    createdAt: now,
    updatedAt: now,
    source: {
      id: "gfwlist-official",
      name: "GFWList (official)",
      enabled: true,
      kind: "gfwlist_official",
      url: null,
      refreshIntervalSeconds: 86_400,
    },
  };
}

function defaultPersistedState(): StubPersistedState {
  return {
    scenario: defaultScenario(),
    profiles: [makeDefaultProfile()],
    ruleSources: [makeDefaultRuleSource()],
  };
}

function loadPersistedState(): StubPersistedState {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "null") as Partial<StubPersistedState> | null;
    if (parsed && parsed.scenario && Array.isArray(parsed.profiles) && Array.isArray(parsed.ruleSources)) {
      return {
        scenario: { ...defaultScenario(), ...parsed.scenario },
        profiles: parsed.profiles,
        ruleSources: parsed.ruleSources,
      };
    }
  } catch {
    // A blocked or corrupt browser store should never make the preview unusable.
  }
  return defaultPersistedState();
}

function savePersistedState(state: StubRuntimeState): void {
  try {
    const persisted: StubPersistedState = {
      scenario: state.scenario,
      profiles: state.profiles,
      ruleSources: state.ruleSources,
    };
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Browser privacy settings may disable storage; in-memory behavior remains usable.
  }
}

function makeRuntimeState(): StubRuntimeState {
  const persisted = loadPersistedState();
  return {
    ...persisted,
    status: persisted.scenario.recoveryRequired
      ? {
          state: "recovery_required",
          message: "Sockscap browser simulation requires recovery",
          activeProfileIds: [],
          lastError: "STUB_RECOVERY_REQUIRED: simulated leftover network state",
          recoveryRequired: true,
          captureActive: false,
        }
      : disabledStatus(),
    statsTotals: zeroTotals(),
    statsSeries: [],
    lastTrafficEmitMillis: 0,
    trafficTimer: null,
  };
}

let runtime = makeRuntimeState();

function capabilities(): SockscapCapabilitiesReport {
  const { platform, capabilityMode } = runtime.scenario;
  const adapter = platform === "windows"
    ? "Wintun + application capture"
    : platform === "macos"
      ? "Network Extension"
      : "cgroup v2 + nftables/TUN";
  const level = capabilityMode === "supported"
    ? "supported"
    : capabilityMode === "unsupported"
      ? "unsupported"
      : "degraded";
  const permissionReady = capabilityMode !== "permission_required";
  const globalReady = capabilityMode === "supported" || capabilityMode === "degraded";
  const scopedReady = capabilityMode === "supported";
  return {
    platform,
    items: [
      {
        id: "capture_global",
        name: `${adapter} global capture`,
        level,
        detail: capabilityMode === "unsupported" ? "Simulated adapter unavailable" : "Browser simulation available",
        requiredForStart: true,
      },
      {
        id: "capture_application",
        name: "Application and PID selection",
        level: scopedReady ? "supported" : level,
        detail: scopedReady ? "Selected application and PID simulation available" : "Simulated scoped capture limitation",
        requiredForStart: false,
      },
      {
        id: "permission",
        name: "Elevated network permission",
        level: permissionReady ? "supported" : "degraded",
        detail: permissionReady ? "Simulated permission granted" : "Simulated permission action required",
        requiredForStart: true,
      },
      {
        id: "dns_ipv6",
        name: "DNS and IPv6 parity",
        level: capabilityMode === "unsupported" ? "unknown" : "supported",
        detail: "Browser simulation covers DNS attribution and IPv4/IPv6 policy",
        requiredForStart: true,
      },
    ],
    canStartGlobal: globalReady && permissionReady,
    canStartAppGroup: scopedReady && permissionReady,
    canAttachPid: scopedReady && permissionReady,
    summary: `${platform} browser capability scenario: ${capabilityMode}`,
    captureImplemented: capabilityMode !== "unsupported",
  };
}

function egressIssue(health: SockscapStubEgressHealth): SockscapEgressIssue | null {
  switch (health) {
    case "healthy":
      return null;
    case "degraded":
      return { code: "EGRESS_CONNECT_FAILED", message: "Simulated upstream connection failure", userActionRequired: false };
    case "user_action_required":
      return { code: "SSH_MFA_REQUIRED", message: "Simulated interactive SSH authentication is required", userActionRequired: true };
    case "invalid":
      return { code: "EGRESS_SESSION_INVALID", message: "Simulated saved session is invalid", userActionRequired: false };
  }
}

function makeEgressSummary(kind: "proxy" | "ssh"): SockscapEgressSessionSummary {
  const health = kind === "proxy" ? runtime.scenario.proxyHealth : runtime.scenario.sshHealth;
  const issue = egressIssue(health);
  return {
    id: kind === "proxy" ? "stub-proxy" : "stub-ssh",
    name: kind === "proxy" ? "Browser SOCKS5 proxy" : "Browser SSH jump",
    kind: kind === "proxy" ? "proxy_session" : "ssh_jump",
    protocol: kind === "proxy" ? "socks5" : "ssh_jump",
    endpointHost: kind === "proxy" ? "proxy.browser.test" : "ssh.browser.test",
    endpointPort: kind === "proxy" ? 1080 : 22,
    authKind: kind === "proxy" ? "username_password" : "agent",
    remoteDns: true,
    tcpOnly: kind === "ssh",
    availability: health === "invalid" ? "invalid" : health === "user_action_required" ? "user_action_required" : "ready",
    issue: health === "degraded" ? null : issue,
  };
}

function testEgress(request: SockscapTestEgressRequest): SockscapTestEgressResult {
  if (!request.targetHost || request.targetPort <= 0 || request.targetPort > 65_535) {
    throw new Error("EGRESS_TEST_TARGET_INVALID: target host or port is invalid");
  }
  const kind = request.sessionId === "stub-proxy" ? "proxy" : request.sessionId === "stub-ssh" ? "ssh" : null;
  if (!kind) throw new Error("EGRESS_SESSION_NOT_FOUND: the selected egress session no longer exists");
  const health = kind === "proxy" ? runtime.scenario.proxyHealth : runtime.scenario.sshHealth;
  const summary = makeEgressSummary(kind);
  const issue = egressIssue(health);
  const ok = health === "healthy";
  return {
    ok,
    summary,
    elapsedMillis: ok ? (kind === "proxy" ? 24 : 41) : 75,
    metadata: ok
      ? {
          connector: kind === "proxy" ? "socks5" : "ssh_jump",
          remoteDns: true,
          tcpOnly: kind === "ssh",
          detail: "browser simulation established a bounded test stream",
        }
      : null,
    issue,
    sshPool: kind === "ssh"
      ? {
          state: health === "healthy"
            ? "healthy"
            : health === "user_action_required"
              ? "user_action_required"
              : "degraded",
          activeControlConnections: health === "healthy" ? 1 : 0,
          activeChannels: health === "healthy" ? 1 : 0,
          lastHandshakeRttMs: health === "healthy" ? 38 : null,
          channelOpenErrors: health === "healthy" ? 0 : 1,
          reconnects: health === "degraded" ? 2 : 0,
          bytesUp: runtime.statsTotals.bytesUp,
          bytesDown: runtime.statsTotals.bytesDown,
          lastErrorCode: issue?.code ?? null,
          lastHostKeyStatus: health === "invalid" ? "changed" : "verified",
        }
      : null,
  };
}

function detectConflicts(profiles: SockscapRoutingProfileDraft[]): SockscapProfileConflict[] {
  const enabled = profiles.filter((profile) => profile.enabled);
  const conflicts: SockscapProfileConflict[] = [];
  const globals = enabled.filter((profile) => profile.scope === "global");
  for (let index = 1; index < globals.length; index += 1) {
    conflicts.push({
      profileA: globals[0].id,
      profileB: globals[index].id,
      reason: "only one enabled global routing profile is allowed",
    });
  }
  for (let left = 0; left < enabled.length; left += 1) {
    for (let right = left + 1; right < enabled.length; right += 1) {
      const a = enabled[left];
      const b = enabled[right];
      if (a.priority !== b.priority) continue;
      const overlap = a.appSelectors.some((selector) =>
        b.appSelectors.some((candidate) => selector.kind === candidate.kind && selector.value === candidate.value));
      if (overlap) {
        conflicts.push({ profileA: a.id, profileB: b.id, reason: "same-priority application selectors overlap" });
      }
    }
  }
  return conflicts;
}

function preflight(): SockscapPreflightReport {
  const report = capabilities();
  const profiles = runtime.profiles.map((record) => record.profile);
  const enabled = profiles.filter((profile) => profile.enabled);
  const conflicts = detectConflicts(profiles);
  const findings: SockscapPreflightReport["findings"] = [];
  if (enabled.some((profile) => profile.scope === "global") && !report.canStartGlobal) {
    findings.push({ code: "capability_global", severity: "error", message: report.summary });
  }
  if (enabled.some((profile) => profile.scope === "applications") && !report.canStartAppGroup) {
    findings.push({ code: "capability_applications", severity: "error", message: report.summary });
  }
  if (enabled.some((profile) => profile.scope === "runtime_processes") && !report.canAttachPid) {
    findings.push({ code: "capability_runtime_pid", severity: "error", message: report.summary });
  }
  if (enabled.length === 0) {
    findings.push({ code: "no_enabled_profiles", severity: "error", message: "No enabled routing profiles" });
  }
  for (const conflict of conflicts) {
    findings.push({ code: "profile_conflict", severity: "error", message: conflict.reason });
  }
  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    capabilities: report,
    conflicts,
    findings,
    suggestedState: findings.length === 0 ? "preparing" : "disabled",
  };
}

function validateProfile(profile: SockscapRoutingProfileDraft): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(profile.id) || !profile.name.trim()) {
    throw new Error("PROFILE_INVALID: id and name are required");
  }
  if (profile.egressKind !== null) {
    const summary = profile.egressRefId === "stub-proxy"
      ? makeEgressSummary("proxy")
      : profile.egressRefId === "stub-ssh"
        ? makeEgressSummary("ssh")
        : null;
    if (!summary) throw new Error("EGRESS_SESSION_NOT_FOUND: selected egress session is unavailable");
    if (summary.kind !== profile.egressKind) throw new Error("EGRESS_KIND_MISMATCH: selected egress has a different kind");
    if (summary.availability === "invalid") throw new Error(summary.issue?.code ?? "EGRESS_SESSION_INVALID");
  }
  const knownSources = new Set(runtime.ruleSources.map((record) => record.source.id));
  if (profile.ruleSourceIds.some((id) => !knownSources.has(id))) {
    throw new Error("RULE_SOURCE_NOT_FOUND: profile references an unknown rule source");
  }
}

function upsertProfile(profile: SockscapRoutingProfileDraft, expectedRevision: number | null): SockscapPersistedRoutingProfile {
  validateProfile(profile);
  const existingIndex = runtime.profiles.findIndex((record) => record.profile.id === profile.id);
  const existing = existingIndex >= 0 ? runtime.profiles[existingIndex] : null;
  const actualRevision = existing?.revision ?? 0;
  if (expectedRevision !== null && expectedRevision !== actualRevision) {
    throw new Error(`PROFILE_REVISION_CONFLICT: expected revision ${expectedRevision}, current revision ${actualRevision}`);
  }
  const candidates = runtime.profiles
    .filter((record) => record.profile.id !== profile.id)
    .map((record) => record.profile)
    .concat(profile);
  const conflict = detectConflicts(candidates)[0];
  if (conflict) throw new Error(`PROFILE_CONFLICT: ${conflict.profileA} and ${conflict.profileB}: ${conflict.reason}`);
  const now = nowUnix();
  const saved: SockscapPersistedRoutingProfile = {
    profile: clone(profile),
    revision: actualRevision + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existingIndex >= 0) runtime.profiles[existingIndex] = saved;
  else runtime.profiles.push(saved);
  savePersistedState(runtime);
  return clone(saved);
}

function deleteProfile(profileId: string, expectedRevision: number | null): void {
  const existing = runtime.profiles.find((record) => record.profile.id === profileId);
  if (!existing) throw new Error(`PROFILE_NOT_FOUND: routing profile '${profileId}' does not exist`);
  if (expectedRevision !== null && expectedRevision !== existing.revision) {
    throw new Error(`PROFILE_REVISION_CONFLICT: expected revision ${expectedRevision}, current revision ${existing.revision}`);
  }
  runtime.profiles = runtime.profiles.filter((record) => record.profile.id !== profileId);
  savePersistedState(runtime);
}

function ruleSourceState(source: SockscapRuleSourceDraft): SockscapRuleSourceState {
  return {
    sourceId: source.id,
    kind: source.kind,
    url: source.url,
    lastGoodPath: null,
    lastSuccessUnix: nowUnix() - 300,
    lastMirror: source.kind === "gfwlist_official" ? "https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt" : source.url,
    lastSha256: "browser-stub-sha256",
    etag: "browser-stub-etag",
    lastModified: null,
    refreshAfterUnix: nowUnix() + source.refreshIntervalSeconds,
    lastError: null,
    parseStats: { totalLines: 4, proxyRules: 2, directRules: 1, unsupported: 0, ignoredComments: 1 },
  };
}

function upsertRuleSource(source: SockscapRuleSourceDraft, expectedRevision: number | null): SockscapPersistedRuleSource {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(source.id) || !source.name.trim()) {
    throw new Error("RULE_SOURCE_INVALID: id and name are required");
  }
  const existingIndex = runtime.ruleSources.findIndex((record) => record.source.id === source.id);
  const existing = existingIndex >= 0 ? runtime.ruleSources[existingIndex] : null;
  if (source.id === "gfwlist-official" && existing) {
    throw new Error("BUILTIN_RULE_SOURCE_READ_ONLY: official GFWList metadata is fixed");
  }
  const actualRevision = existing?.revision ?? 0;
  if (expectedRevision !== null && expectedRevision !== actualRevision) {
    throw new Error(`RULE_SOURCE_REVISION_CONFLICT: expected revision ${expectedRevision}, current revision ${actualRevision}`);
  }
  if (source.kind === "custom_url" && !/^https?:\/\//.test(source.url ?? "")) {
    throw new Error("RULE_SOURCE_URL_INVALID: custom URL must use http or https");
  }
  if (source.refreshIntervalSeconds < 21_600) {
    throw new Error("RULE_SOURCE_REFRESH_INVALID: refresh interval must be at least 21600 seconds");
  }
  const now = nowUnix();
  const saved: SockscapPersistedRuleSource = {
    source: clone(source),
    revision: actualRevision + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existingIndex >= 0) runtime.ruleSources[existingIndex] = saved;
  else runtime.ruleSources.push(saved);
  savePersistedState(runtime);
  return clone(saved);
}

function deleteRuleSource(sourceId: string, expectedRevision: number | null): void {
  if (sourceId === "gfwlist-official") throw new Error("BUILTIN_RULE_SOURCE_READ_ONLY: official source cannot be deleted");
  const existing = runtime.ruleSources.find((record) => record.source.id === sourceId);
  if (!existing) throw new Error(`RULE_SOURCE_NOT_FOUND: rule source '${sourceId}' does not exist`);
  if (expectedRevision !== null && expectedRevision !== existing.revision) {
    throw new Error(`RULE_SOURCE_REVISION_CONFLICT: expected revision ${expectedRevision}, current revision ${existing.revision}`);
  }
  if (runtime.profiles.some((record) => record.profile.ruleSourceIds.includes(sourceId))) {
    throw new Error("RULE_SOURCE_IN_USE: remove the rule source from profiles before deleting it");
  }
  runtime.ruleSources = runtime.ruleSources.filter((record) => record.source.id !== sourceId);
  savePersistedState(runtime);
}

function compileRules(sourceId: string, payload: string): SockscapParseReport {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sourceId)) {
    throw new Error("rule source id must be 1-128 ASCII letters, digits, '-' or '_'");
  }
  if (new TextEncoder().encode(payload).byteLength > 5 * 1024 * 1024) {
    throw new Error("rule payload exceeds 5242880 byte limit");
  }
  const proxyRules: SockscapCompiledRule[] = [];
  const directRules: SockscapCompiledRule[] = [];
  const unsupported: SockscapParseReport["unsupported"] = [];
  let ignoredComments = 0;
  const lines = payload.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) {
      ignoredComments += 1;
      continue;
    }
    const direct = line.startsWith("@@||");
    const match = line.match(/^(@@)?\|\|([A-Za-z0-9.-]+)\^?$/);
    if (!match) {
      unsupported.push({ original: line, reason: "browser stub only projects unambiguous domain anchors" });
      continue;
    }
    const rule: SockscapCompiledRule = {
      action: direct ? "direct" : "proxy",
      kind: "domain_suffix",
      pattern: match[2].replace(/\.$/, "").toLowerCase(),
      original: line,
      sourceId,
    };
    (direct ? directRules : proxyRules).push(rule);
  }
  return { proxyRules, directRules, unsupported, ignoredComments, totalLines: lines.length };
}

function refreshOutcome(sourceId: string, payload = "[AutoProxy 0.2.9]\n||blocked.example\n@@||direct.example"): SockscapRefreshOutcome {
  const report = compileRules(sourceId, payload);
  return {
    ok: true,
    usedLastGood: false,
    notModified: false,
    mirror: sourceId === "gfwlist-official"
      ? "https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt"
      : runtime.ruleSources.find((record) => record.source.id === sourceId)?.source.url ?? null,
    sha256: "browser-stub-sha256",
    parseStats: {
      totalLines: report.totalLines,
      proxyRules: report.proxyRules.length,
      directRules: report.directRules.length,
      unsupported: report.unsupported.length,
      ignoredComments: report.ignoredComments,
    },
    error: null,
    report,
  };
}

function testTarget(request: SockscapTestTargetRequest): SockscapTestTargetResult {
  if (request.port <= 0 || request.port > 65_535) {
    throw new Error("TEST_TARGET_INVALID: port must be between 1 and 65535");
  }
  if ((request.pid === null) !== (request.processStartTime === null)
    || request.pid === 0
    || request.processStartTime === 0) {
    throw new Error("TEST_TARGET_INVALID: PID and non-zero processStartTime must be supplied together");
  }
  if (request.hostname === null && request.ip === null) {
    throw new Error("TEST_TARGET_INVALID: hostname or IP address is required");
  }
  const profile = runtime.profiles
    .map((record) => record.profile)
    .filter((candidate) => candidate.enabled)
    .sort((left, right) => left.priority - right.priority)[0];
  if (!profile) {
    return {
      selectedProfileId: null,
      selectedProfileName: null,
      selectionReason: "no enabled routing profile",
      decision: null,
      conflicts: [],
      notes: ["Browser simulation uses saved profiles only."],
    };
  }
  const hostname = request.hostname?.toLowerCase() ?? null;
  const hardBypass = request.hardBypass || hostname === "localhost" || request.ip === "127.0.0.1" || request.ip === "::1";
  const matched = hostname?.endsWith("blocked.example") ?? false;
  const action = hardBypass ? "direct" : matched ? "proxy" : profile.defaultAction;
  return {
    selectedProfileId: profile.id,
    selectedProfileName: profile.name,
    selectionReason: profile.scope === "global" ? "enabled global profile" : "simulated selector match",
    decision: {
      action,
      matchedRuleOriginal: matched ? "||blocked.example" : null,
      matchedRuleSourceId: matched ? "gfwlist-official" : null,
      matchedStage: hardBypass ? "hard_bypass" : matched ? "subscription_proxy" : "profile_default",
      hostnameSource: request.hostnameSource ?? (hostname ? "platform_remote_hostname" : "ip_only"),
      profileId: profile.id,
    },
    conflicts: detectConflicts(runtime.profiles.map((record) => record.profile)),
    notes: ["Browser simulation never accepts caller-owned profile or matcher payloads."],
  };
}

function processCatalog(): SockscapProcessCatalog {
  return {
    processes: [
      {
        pid: 4100,
        parentPid: 1,
        name: "Browser",
        executablePath: runtime.scenario.platform === "windows" ? "C:\\Program Files\\Browser\\browser.exe" : "/usr/bin/browser",
        processStartTime: nowUnix() - 7200,
        selectable: true,
        rememberable: true,
        issueCode: null,
      },
      {
        pid: 4200,
        parentPid: 4100,
        name: "Browser Helper",
        executablePath: runtime.scenario.platform === "macos" ? "/Applications/Browser.app/Contents/MacOS/Browser Helper" : null,
        processStartTime: nowUnix() - 7100,
        selectable: true,
        rememberable: runtime.scenario.platform === "macos",
        issueCode: null,
      },
      {
        pid: 4300,
        parentPid: 1,
        name: "Taomni (browser preview)",
        executablePath: null,
        processStartTime: nowUnix() - 300,
        selectable: false,
        rememberable: false,
        issueCode: "PROCESS_IS_TAOMNI",
      },
    ],
    truncated: false,
    maxRows: 4096,
  };
}

function statsSnapshot(query: SockscapStatsSnapshotQuery): SockscapStatsSnapshot {
  const series = runtime.statsSeries.filter((point) => point.bucketStart >= query.fromUnix && point.bucketStart <= query.toUnix);
  const limit = Math.max(1, Math.min(query.limit, 1000));
  return {
    generatedAt: nowUnix(),
    fromUnix: query.fromUnix,
    toUnix: query.toUnix,
    totals: clone(runtime.statsTotals),
    series: clone(series.slice(-limit)),
    topApplications: runtime.statsTotals.connections === 0
      ? []
      : [{ key: "Browser", bytesUp: runtime.statsTotals.bytesUp, bytesDown: runtime.statsTotals.bytesDown, connections: runtime.statsTotals.connections }],
    topDomains: query.includeDomains
      && runtime.profiles.some((record) => record.profile.enabled && record.profile.statsPrivacy.domainAggregationEnabled)
      && runtime.statsTotals.connections > 0
      ? [{ key: "blocked.example", bytesUp: Math.floor(runtime.statsTotals.bytesUp / 2), bytesDown: Math.floor(runtime.statsTotals.bytesDown / 2), connections: Math.max(1, Math.floor(runtime.statsTotals.connections / 2)) }]
      : [],
    egressHealth: [],
  };
}

async function publishStatus(): Promise<void> {
  await emit(SOCKSCAP_EVENTS.status, clone(runtime.status));
}

async function publishAlert(code: string, message: string): Promise<void> {
  const alert: SockscapAlertEvent = { code, message, severity: "error", createdAtUnix: nowUnix() };
  await emit(SOCKSCAP_EVENTS.alert, alert);
}

function reconcileActiveEgressHealth(): void {
  if (!runtime.status.captureActive) return;
  const activeProfiles = runtime.profiles.filter((record) => runtime.status.activeProfileIds.includes(record.profile.id));
  const health = activeProfiles
    .map((record) => record.profile.egressRefId === "stub-ssh" ? runtime.scenario.sshHealth : runtime.scenario.proxyHealth)
    .find((candidate) => candidate !== "healthy");
  if (!health) {
    runtime.status = {
      ...runtime.status,
      state: "active",
      message: `Sockscap ${runtime.scenario.platform} browser simulation is active`,
      lastError: null,
    };
  } else if (health === "user_action_required") {
    runtime.status = {
      ...runtime.status,
      state: "user_action_required",
      message: "Sockscap upstream requires user action",
      lastError: "SSH_MFA_REQUIRED: simulated interactive SSH authentication is required",
    };
  } else {
    runtime.status = {
      ...runtime.status,
      state: "degraded",
      message: "Sockscap upstream is degraded",
      lastError: egressIssue(health)?.code ?? "EGRESS_CONNECT_FAILED",
    };
  }
}

function stopTrafficTimer(): void {
  if (runtime.trafficTimer !== null) globalThis.clearInterval(runtime.trafficTimer);
  runtime.trafficTimer = null;
}

function startTrafficTimer(): void {
  stopTrafficTimer();
  if (runtime.scenario.trafficMode === "idle") return;
  runtime.trafficTimer = globalThis.setInterval(() => {
    void emitTraffic(false);
  }, 1000);
}

async function emitTraffic(force: boolean): Promise<SockscapTrafficSummaryEvent | null> {
  if (runtime.status.state !== "active" || runtime.scenario.trafficMode === "idle") return null;
  const nowMillis = Date.now();
  if (!force && nowMillis - runtime.lastTrafficEmitMillis < 950) return null;
  runtime.lastTrafficEmitMillis = nowMillis;
  const scale = runtime.scenario.trafficMode === "burst" ? 12 : 1;
  const bytesUp = 8_192 * scale;
  const bytesDown = 32_768 * scale;
  const connections = 2 * scale;
  runtime.statsTotals.bytesUp += bytesUp;
  runtime.statsTotals.bytesDown += bytesDown;
  runtime.statsTotals.connections += connections;
  runtime.statsTotals.proxyConnections += connections;
  runtime.statsTotals.connectMillisTotal += 24 * connections;
  const bucketStart = Math.floor(nowUnix() / 60) * 60;
  let point = runtime.statsSeries.find((candidate) => candidate.bucketStart === bucketStart);
  if (!point) {
    point = {
      bucketStart,
      resolutionSeconds: 60,
      bytesUp: 0,
      bytesDown: 0,
      connections: 0,
      errors: 0,
      directConnections: 0,
      proxyConnections: 0,
      blockedConnections: 0,
    };
    runtime.statsSeries.push(point);
    runtime.statsSeries = runtime.statsSeries.slice(-1440);
  }
  point.bytesUp += bytesUp;
  point.bytesDown += bytesDown;
  point.connections += connections;
  point.proxyConnections += connections;
  const event: SockscapTrafficSummaryEvent = {
    generatedAtUnix: nowUnix(),
    totals: clone(runtime.statsTotals),
    cleared: false,
  };
  await emit(SOCKSCAP_EVENTS.trafficSummary, event);
  return event;
}

async function startEngine(): Promise<SockscapEngineStatus> {
  if (runtime.scenario.recoveryRequired) {
    const error = "RECOVERY_REQUIRED: simulated network cleanup must complete before start";
    await publishAlert("RECOVERY_REQUIRED", error);
    throw new Error(error);
  }
  const report = preflight();
  if (!report.ok) {
    const finding = report.findings[0];
    const error = `SOCKSCAP_PREFLIGHT_FAILED: ${finding?.message ?? "preflight failed"}`;
    runtime.status = { ...disabledStatus(), lastError: error };
    await publishStatus();
    await publishAlert("SOCKSCAP_PREFLIGHT_FAILED", error);
    throw new Error(error);
  }
  const activeProfileIds = runtime.profiles.filter((record) => record.profile.enabled).map((record) => record.profile.id);
  runtime.status = {
    state: "active",
    message: `Sockscap ${runtime.scenario.platform} browser simulation is active`,
    activeProfileIds,
    lastError: null,
    recoveryRequired: false,
    captureActive: true,
  };
  startTrafficTimer();
  await publishStatus();
  return clone(runtime.status);
}

async function stopEngine(): Promise<SockscapEngineStatus> {
  stopTrafficTimer();
  runtime.status = disabledStatus();
  await publishStatus();
  return clone(runtime.status);
}

async function recoverEngine(): Promise<SockscapEngineStatus> {
  runtime.scenario.recoveryRequired = false;
  savePersistedState(runtime);
  return stopEngine();
}

function argsRecord(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
}

export async function invokeSockscapStub(command: string, rawArgs?: unknown): Promise<SockscapStubInvokeResult> {
  if (!command.startsWith("sockscap_")) return { handled: false };
  const args = argsRecord(rawArgs);
  switch (command) {
    case "sockscap_capabilities":
      return { handled: true, value: capabilities() };
    case "sockscap_status":
      return { handled: true, value: clone(runtime.status) };
    case "sockscap_preflight":
      return { handled: true, value: preflight() };
    case "sockscap_list_profiles":
      return { handled: true, value: clone(runtime.profiles) };
    case "sockscap_upsert_profile": {
      const saved = upsertProfile(args.profile as SockscapRoutingProfileDraft, (args.expectedRevision as number | null | undefined) ?? null);
      const health: SockscapProfileHealthEvent = {
        profileId: saved.profile.id,
        enabled: saved.profile.enabled,
        egress: saved.profile.egressRefId === "stub-ssh" ? makeEgressSummary("ssh") : saved.profile.egressRefId === "stub-proxy" ? makeEgressSummary("proxy") : null,
        issue: null,
      };
      await emit(SOCKSCAP_EVENTS.profileHealth, health);
      return { handled: true, value: saved };
    }
    case "sockscap_delete_profile": {
      const profileId = String(args.profileId ?? "");
      deleteProfile(profileId, (args.expectedRevision as number | null | undefined) ?? null);
      await emit(SOCKSCAP_EVENTS.profileHealth, {
        profileId,
        enabled: false,
        egress: null,
        issue: { code: "PROFILE_DELETED", message: "routing profile was deleted", userActionRequired: false },
      } satisfies SockscapProfileHealthEvent);
      return { handled: true, value: undefined };
    }
    case "sockscap_list_processes":
      return { handled: true, value: processCatalog() };
    case "sockscap_start":
      return { handled: true, value: await startEngine() };
    case "sockscap_stop":
      return { handled: true, value: await stopEngine() };
    case "sockscap_recover":
      return { handled: true, value: await recoverEngine() };
    case "sockscap_open_window":
      return { handled: true, value: undefined };
    case "sockscap_list_egress_sessions":
      return { handled: true, value: [makeEgressSummary("proxy"), makeEgressSummary("ssh")] };
    case "sockscap_test_egress": {
      const result = testEgress(args.request as SockscapTestEgressRequest);
      await emit(SOCKSCAP_EVENTS.egressHealth, result);
      return { handled: true, value: result };
    }
    case "sockscap_test_target":
      return { handled: true, value: testTarget(args.request as SockscapTestTargetRequest) };
    case "sockscap_compile_rules":
      return { handled: true, value: compileRules(String(args.sourceId ?? ""), String(args.payload ?? "")) };
    case "sockscap_list_rule_sources": {
      const views: SockscapRuleSourceView[] = runtime.ruleSources.map((record) => ({
        record: clone(record),
        state: ruleSourceState(record.source),
      }));
      return { handled: true, value: views };
    }
    case "sockscap_upsert_rule_source":
      return {
        handled: true,
        value: upsertRuleSource(args.source as SockscapRuleSourceDraft, (args.expectedRevision as number | null | undefined) ?? null),
      };
    case "sockscap_delete_rule_source":
      deleteRuleSource(String(args.sourceId ?? ""), (args.expectedRevision as number | null | undefined) ?? null);
      return { handled: true, value: undefined };
    case "sockscap_import_rule_source": {
      const sourceId = String(args.sourceId ?? "");
      if (!runtime.ruleSources.some((record) => record.source.id === sourceId)) {
        throw new Error(`RULE_SOURCE_NOT_FOUND: rule source '${sourceId}' does not exist`);
      }
      return { handled: true, value: refreshOutcome(sourceId, String(args.payload ?? "")) };
    }
    case "sockscap_refresh_rule_source": {
      const sourceId = String(args.sourceId ?? "");
      if (!runtime.ruleSources.some((record) => record.source.id === sourceId)) {
        throw new Error(`RULE_SOURCE_NOT_FOUND: rule source '${sourceId}' does not exist`);
      }
      return { handled: true, value: refreshOutcome(sourceId) };
    }
    case "sockscap_stats_snapshot":
      return { handled: true, value: statsSnapshot(args.query as SockscapStatsSnapshotQuery) };
    case "sockscap_clear_stats": {
      const removedRows = runtime.statsSeries.length;
      runtime.statsTotals = zeroTotals();
      runtime.statsSeries = [];
      const event: SockscapTrafficSummaryEvent = { generatedAtUnix: nowUnix(), totals: zeroTotals(), cleared: true };
      await emit(SOCKSCAP_EVENTS.trafficSummary, event);
      return { handled: true, value: { removedRows } satisfies SockscapClearStatsResult };
    }
    case "sockscap_gfwlist_official_info":
      return {
        handled: true,
        value: {
          sourceId: "gfwlist-official",
          mirrors: [
            "https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt",
            "https://gitlab.com/gfwlist/gfwlist/raw/master/gfwlist.txt",
            "https://repo.or.cz/gfwlist.git/blob_plain/HEAD:/gfwlist.txt",
          ],
        },
      };
    default:
      return { handled: false };
  }
}

export const sockscapStubController: SockscapStubController = {
  async configure(patch) {
    runtime.scenario = { ...runtime.scenario, ...patch };
    if (runtime.scenario.recoveryRequired) {
      stopTrafficTimer();
      runtime.status = {
        state: "recovery_required",
        message: "Sockscap browser simulation requires recovery",
        activeProfileIds: [],
        lastError: "STUB_RECOVERY_REQUIRED: simulated leftover network state",
        recoveryRequired: true,
        captureActive: false,
      };
    } else if (runtime.status.state === "recovery_required") {
      runtime.status = disabledStatus();
    }
    reconcileActiveEgressHealth();
    if (runtime.status.state === "active") startTrafficTimer();
    savePersistedState(runtime);
    await publishStatus();
    if (patch.proxyHealth !== undefined) {
      await emit(SOCKSCAP_EVENTS.egressHealth, testEgress({
        sessionId: "stub-proxy",
        targetHost: "example.com",
        targetPort: 443,
        timeoutMillis: 15_000,
        interactive: false,
        sshPoolOptions: {
          maxControlConnections: 2,
          maxChannelsPerConnection: 128,
          keepaliveSeconds: 30,
          connectTimeoutSeconds: 15,
        },
      }));
    }
    if (patch.sshHealth !== undefined) {
      await emit(SOCKSCAP_EVENTS.egressHealth, testEgress({
        sessionId: "stub-ssh",
        targetHost: "example.com",
        targetPort: 443,
        timeoutMillis: 15_000,
        interactive: false,
        sshPoolOptions: {
          maxControlConnections: 2,
          maxChannelsPerConnection: 128,
          keepaliveSeconds: 30,
          connectTimeoutSeconds: 15,
        },
      }));
    }
    return clone(runtime.scenario);
  },
  async reset() {
    stopTrafficTimer();
    try {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch {
      // Ignore browser storage denial.
    }
    runtime = makeRuntimeState();
    savePersistedState(runtime);
    await publishStatus();
  },
  snapshot() {
    return clone(runtime.scenario);
  },
  async emitTraffic() {
    return emitTraffic(true);
  },
};

const stubGlobal = globalThis as typeof globalThis & {
  __TAOMNI_SOCKSCAP_STUB__?: SockscapStubController;
};
stubGlobal.__TAOMNI_SOCKSCAP_STUB__ = sockscapStubController;
