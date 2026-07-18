import type {
  SockscapCustomRuleDraft,
  SockscapRuleSourceDraft,
  SockscapRuleSourceKind,
  SockscapTestTargetRequest,
} from "./sockscap";

export interface SockscapRuleDraftIssue {
  field: string;
  message: string;
}

export interface SockscapTargetDraft {
  appIdentity: string;
  appSelectorKind: SockscapTestTargetRequest["appSelectorKind"];
  pid: number | null;
  processStartTime: number | null;
  target: string;
  port: number;
  protocol: SockscapTestTargetRequest["protocol"];
  hostnameSource: SockscapTestTargetRequest["hostnameSource"];
  hardBypass: boolean;
}

export function createSockscapRuleId(prefix: "source" | "rule", now = Date.now(), random = Math.random()): string {
  const entropy = Math.floor(Math.max(0, random) * 0x1000000).toString(36).padStart(5, "0");
  return `${prefix}-${now.toString(36)}-${entropy}`;
}

export function createSockscapRuleSourceDraft(
  kind: Exclude<SockscapRuleSourceKind, "gfwlist_official">,
  id = createSockscapRuleId("source"),
  name = "",
): SockscapRuleSourceDraft {
  return {
    id,
    name,
    enabled: true,
    kind,
    url: kind === "custom_url" ? "https://" : null,
    refreshIntervalSeconds: 6 * 60 * 60,
  };
}

export function createSockscapCustomRuleDraft(
  id = createSockscapRuleId("rule"),
): SockscapCustomRuleDraft {
  return {
    id,
    enabled: true,
    action: "direct",
    kind: "domain_suffix",
    pattern: "",
  };
}

export function validateSockscapRuleSourceDraft(source: SockscapRuleSourceDraft): SockscapRuleDraftIssue[] {
  const issues: SockscapRuleDraftIssue[] = [];
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(source.id)) {
    issues.push({ field: "id", message: "Source ID must use safe ASCII identifier characters." });
  }
  if (!source.name.trim() || source.name !== source.name.trim() || [...source.name].length > 128) {
    issues.push({ field: "name", message: "Name must contain 1-128 trimmed characters." });
  }
  if (!Number.isInteger(source.refreshIntervalSeconds)
    || source.refreshIntervalSeconds < 15 * 60
    || source.refreshIntervalSeconds > 30 * 24 * 60 * 60) {
    issues.push({ field: "refreshIntervalSeconds", message: "Refresh interval must be between 15 minutes and 30 days." });
  }
  if (source.kind === "gfwlist_official") {
    issues.push({ field: "kind", message: "The official source is read-only." });
  } else if (source.kind === "custom_url") {
    try {
      const url = new URL(source.url ?? "");
      if (!(["http:", "https:"] as string[]).includes(url.protocol)
        || url.username
        || url.password
        || (source.url?.length ?? 0) > 4096) {
        throw new Error("unsafe URL");
      }
    } catch {
      issues.push({ field: "url", message: "Custom sources require an HTTP(S) URL without embedded credentials." });
    }
  } else if (source.url !== null) {
    issues.push({ field: "url", message: "Local imports do not persist an external file path." });
  }
  return issues;
}

export function validateSockscapCustomRules(rules: SockscapCustomRuleDraft[]): SockscapRuleDraftIssue[] {
  const issues: SockscapRuleDraftIssue[] = [];
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(rule.id) || ids.has(rule.id)) {
      issues.push({ field: "customRules", message: "Manual rule IDs must be unique safe identifiers." });
    }
    ids.add(rule.id);
    if (!rule.pattern.trim() || rule.pattern.length > 4096) {
      issues.push({ field: "customRules", message: "Manual rule patterns must contain 1-4096 characters." });
    }
  }
  return issues;
}

export function buildSockscapTestTargetRequest(draft: SockscapTargetDraft): SockscapTestTargetRequest {
  const target = draft.target.trim();
  const ip = isIpLiteral(target) ? normalizeIpLiteral(target) : null;
  return {
    appIdentity: draft.appIdentity.trim() || null,
    appSelectorKind: draft.appIdentity.trim() ? draft.appSelectorKind : null,
    pid: draft.pid,
    processStartTime: draft.processStartTime,
    hostname: ip ? null : target || null,
    ip,
    port: draft.port,
    protocol: draft.protocol,
    hostnameSource: ip ? "ip_only" : draft.hostnameSource,
    hardBypass: draft.hardBypass,
  };
}

export function validateSockscapTargetDraft(draft: SockscapTargetDraft): SockscapRuleDraftIssue[] {
  const issues: SockscapRuleDraftIssue[] = [];
  if (!draft.target.trim()) issues.push({ field: "target", message: "A hostname or IP address is required." });
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65_535) {
    issues.push({ field: "port", message: "Port must be between 1 and 65535." });
  }
  if ((draft.pid === null) !== (draft.processStartTime === null)
    || draft.pid === 0
    || draft.processStartTime === 0) {
    issues.push({ field: "process", message: "PID and a non-zero process start token must be supplied together." });
  }
  if (draft.appIdentity.trim() && !draft.appSelectorKind) {
    issues.push({ field: "appIdentity", message: "Application identity kind is required." });
  }
  return issues;
}

function isIpLiteral(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  return value.includes(":") && /^[0-9a-fA-F:[\].%]+$/.test(value);
}

function normalizeIpLiteral(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
