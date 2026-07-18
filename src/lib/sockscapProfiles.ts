import type {
  SockscapCapabilitiesReport,
  SockscapEgressSessionSummary,
  SockscapProfileScope,
  SockscapRoutingProfileDraft,
} from "./sockscap";

export interface SockscapProfileDraftIssue {
  field: string;
  message: string;
}

export function createSockscapProfileId(now = Date.now(), random = Math.random()): string {
  const entropy = Math.floor(Math.max(0, random) * 0x1000000).toString(36).padStart(5, "0");
  return `profile-${now.toString(36)}-${entropy}`;
}

export function createSockscapProfileDraft(
  id = createSockscapProfileId(),
  name = "",
): SockscapRoutingProfileDraft {
  return {
    id,
    name,
    enabled: false,
    priority: 100,
    scope: "applications",
    appSelectors: [],
    runtimeProcesses: [],
    includeChildren: true,
    egressKind: null,
    egressRefId: null,
    egressFailureAction: "fail_open",
    sshPoolOptions: {
      maxControlConnections: 2,
      maxChannelsPerConnection: 128,
      keepaliveSeconds: 30,
      connectTimeoutSeconds: 15,
    },
    ruleSourceIds: [],
    customRules: [],
    defaultAction: "direct",
    dnsMode: "system_capture",
    unknownDomainAction: "direct",
    udpPolicy: "block",
    localNetworkPolicy: { lanAction: "direct" },
    statsPrivacy: {
      collectionMode: "persisted",
      minuteRetentionDays: 7,
      hourlyRetentionDays: 90,
      domainAggregationEnabled: false,
      domainRetentionDays: 7,
    },
  };
}

export function changeSockscapProfileScope(
  profile: SockscapRoutingProfileDraft,
  scope: SockscapProfileScope,
): SockscapRoutingProfileDraft {
  return {
    ...profile,
    scope,
    appSelectors: scope === "applications" ? profile.appSelectors : [],
    runtimeProcesses: scope === "runtime_processes" ? profile.runtimeProcesses : [],
  };
}

export function selectSockscapEgress(
  profile: SockscapRoutingProfileDraft,
  egress: SockscapEgressSessionSummary | null,
): SockscapRoutingProfileDraft {
  if (!egress) {
    return { ...profile, egressKind: null, egressRefId: null };
  }
  return {
    ...profile,
    egressKind: egress.kind,
    egressRefId: egress.id,
    udpPolicy: egress.tcpOnly ? "block" : profile.udpPolicy,
  };
}

export function sockscapScopeSupported(
  capabilities: SockscapCapabilitiesReport | null,
  scope: SockscapProfileScope,
): boolean {
  if (!capabilities) return true;
  if (scope === "global") return capabilities.canStartGlobal;
  if (scope === "applications") return capabilities.canStartAppGroup;
  return capabilities.canAttachPid;
}

export function validateSockscapProfileDraft(
  profile: SockscapRoutingProfileDraft,
  egress: SockscapEgressSessionSummary | null,
): SockscapProfileDraftIssue[] {
  const issues: SockscapProfileDraftIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(profile.id)) add("id", "Profile ID is invalid.");
  if (!profile.name.trim() || profile.name !== profile.name.trim() || [...profile.name].length > 128) {
    add("name", "Name must contain 1-128 characters without leading or trailing whitespace.");
  }
  if (!Number.isInteger(profile.priority) || profile.priority < 0 || profile.priority > 4_294_967_295) {
    add("priority", "Priority must be a whole number between 0 and 4294967295.");
  }
  if (profile.enabled && profile.scope === "applications" && profile.appSelectors.length === 0) {
    add("appSelectors", "An enabled application profile needs at least one application selector.");
  }
  if (profile.enabled && profile.scope === "runtime_processes" && profile.runtimeProcesses.length === 0) {
    add("runtimeProcesses", "An enabled runtime profile needs at least one PID and start-time selector.");
  }
  if (profile.scope !== "applications" && profile.appSelectors.length > 0) {
    add("appSelectors", "Application selectors are only valid for application scope.");
  }
  if (profile.scope !== "runtime_processes" && profile.runtimeProcesses.length > 0) {
    add("runtimeProcesses", "Runtime selectors are only valid for runtime-process scope.");
  }
  if ((profile.egressKind === null) !== (profile.egressRefId === null)) {
    add("egress", "Egress kind and saved session must be selected together.");
  }
  if (profile.egressRefId && (!egress || egress.id !== profile.egressRefId || egress.kind !== profile.egressKind)) {
    add("egress", "The selected saved egress session is unavailable or has a different kind.");
  }
  if (!profile.egressRefId && (profile.defaultAction === "proxy" || profile.unknownDomainAction === "proxy")) {
    add("egress", "PROXY actions require a saved Proxy or SSH egress session.");
  }
  const pool = profile.sshPoolOptions;
  if (!inIntegerRange(pool.maxControlConnections, 1, 16)
    || !inIntegerRange(pool.maxChannelsPerConnection, 1, 4096)
    || !inIntegerRange(pool.keepaliveSeconds, 1, 3600)
    || !inIntegerRange(pool.connectTimeoutSeconds, 1, 300)) {
    add("sshPoolOptions", "SSH pool limits or timeouts are outside safe bounds.");
  }
  const privacy = profile.statsPrivacy;
  if (!inIntegerRange(privacy.minuteRetentionDays, 1, 365)
    || !inIntegerRange(privacy.hourlyRetentionDays, privacy.minuteRetentionDays, 3650)
    || (privacy.domainAggregationEnabled && !inIntegerRange(privacy.domainRetentionDays, 1, 365))) {
    add("statsPrivacy", "Statistics retention is outside safe bounds.");
  }
  return issues;
}

function inIntegerRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}
