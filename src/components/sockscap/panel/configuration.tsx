import { type SocksCapCapabilities, type SocksCapConfig, type SocksCapProfile } from "../../../lib/sockscap";


export interface Props {
  onStatusMessage?: (msg: string) => void;
  onClose?: () => void;
}


export const SOCKSCAP_MACOS_SETUP_STORAGE_KEY =
  "taomni.sockscap.macosSetupGuide.v1";


export type MacosSetupGuideMode = "onboarding" | "help";


export type EnvironmentDraft = {
  id: number;
  name: string;
  value: string;
};


export function hasCompletedMacosSetup(): boolean {
  try {
    return window.localStorage.getItem(SOCKSCAP_MACOS_SETUP_STORAGE_KEY) === "complete";
  } catch {
    return false;
  }
}


export const DEFAULT_PROFILE: SocksCapProfile = {
  id: "default",
  name: "Default Profile",
  icon: "🎮",
  color: null,
  enabled: true,
  priority: 0,
  mode: "global",
  apps: [],
  upstream: {
    kind: "socks5",
    sessionId: "",
    host: "127.0.0.1",
    port: 1080,
    username: "",
    passwordRef: "",
  },
  ruleMode: "gfwList",
  userRules: [],
  defaultAction: "direct",
};


export const DEFAULT_CFG: SocksCapConfig = {
  enabled: false,
  activeProfileIds: ["default"],
  selectedProfileId: "default",
  profiles: [DEFAULT_PROFILE],
  mode: "global",
  apps: [],
  upstream: DEFAULT_PROFILE.upstream,
  ruleMode: "gfwList",
  gfwlist: {
    enabled: true,
    url: "https://cdn.jsdelivr.net/gh/gfwlist/gfwlist/gfwlist.txt",
    autoRefreshHours: 24,
  },
  userRules: [],
  bypassCidrs: [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
  ],
  defaultAction: "direct",
  restoreOnLogin: false,
  blockQuic: true,
};


export const MIN_PROFILE_PRIORITY = -2_147_483_648;

export const MAX_PROFILE_PRIORITY = 2_147_483_647;


export type IndexedProfile = {
  profile: SocksCapProfile;
  index: number;
};


/** Match the backend's ascending, stable priority order for presentation. */
export function profilesByPriority(profiles: SocksCapProfile[]): IndexedProfile[] {
  return profiles
    .map((profile, index) => ({ profile, index }))
    .sort((a, b) => a.profile.priority - b.profile.priority || a.index - b.index);
}


export type SessionOpt = { id: string; name: string; host: string; port: number; kind: "proxy" | "ssh"; groupPath?: string | null };


export function phaseTone(phase: string): string {
  switch (phase) {
    case "active":
      return "text-emerald-500";
    case "degraded":
      return "text-amber-500";
    case "preparing":
    case "stopping":
      return "text-sky-500";
    case "recoveryRequired":
      return "text-red-500";
    default:
      return "text-[var(--taomni-text-muted)]";
  }
}


export function needsStartElevation(caps: SocksCapCapabilities | null): boolean {
  return caps?.platform === "linux" && caps.privilegedRequired;
}


export function needsRecoveryElevation(platform: string | undefined): boolean {
  return platform === "linux";
}


export function isRootRequiredError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("cap_net_admin") ||
    lower.includes("linux capture requires") ||
    lower.includes("linux capture needs root") ||
    lower.includes("linux cgroup cleanup requires") ||
    lower.includes("permission to manage cgroup v2")
  );
}


export function isSudoAuthenticationError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("incorrect password") ||
    lower.includes("authentication failure") ||
    lower.includes("sudo authentication failed") ||
    lower.includes("sorry, try again") ||
    lower.includes("a password is required")
  );
}


export function normalizeFrontendConfig(raw: SocksCapConfig): SocksCapConfig {
  const defaultProf: SocksCapProfile = {
    id: "default",
    name: "Default Profile",
    icon: "🎮",
    color: null,
    enabled: true,
    priority: 0,
    mode: raw.mode || "global",
    apps: raw.apps || [],
    upstream: raw.upstream || { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080 },
    ruleMode: raw.ruleMode || "gfwList",
    userRules: raw.userRules || [],
    defaultAction: raw.defaultAction || "direct",
  };
  const profiles = raw.profiles && raw.profiles.length > 0 ? raw.profiles : [defaultProf];
  const activeProfileIds =
    raw.activeProfileIds && raw.activeProfileIds.length > 0
      ? raw.activeProfileIds
      : [profiles[0].id];
  const selectedProfileId =
    raw.selectedProfileId && profiles.some((p) => p.id === raw.selectedProfileId)
      ? raw.selectedProfileId
      : profiles[0].id;
  const selectedProf = profiles.find((p) => p.id === selectedProfileId) || profiles[0];

  return {
    ...raw,
    profiles,
    activeProfileIds,
    selectedProfileId,
    mode: selectedProf.mode,
    apps: selectedProf.apps,
    upstream: selectedProf.upstream,
    ruleMode: selectedProf.ruleMode,
    userRules: selectedProf.userRules,
    defaultAction: selectedProf.defaultAction,
  };
}
