import { create } from "zustand";
import {
  listenSockscapAlert,
  listenSockscapEgressHealth,
  listenSockscapProfileHealth,
  listenSockscapStatus,
  listenSockscapTrafficSummary,
  sockscapCapabilities,
  sockscapListEgressSessions,
  sockscapListProcesses,
  sockscapListProfiles,
  sockscapListRuleSources,
  sockscapRecover,
  sockscapDeleteProfile,
  sockscapStart,
  sockscapStatsSnapshot,
  sockscapStatus,
  sockscapStop,
  sockscapTestEgress,
  sockscapUpsertProfile,
  type SockscapAlertEvent,
  type SockscapCapabilitiesReport,
  type SockscapEgressSessionSummary,
  type SockscapEngineStatus,
  type SockscapPersistedRoutingProfile,
  type SockscapProcessCatalog,
  type SockscapProfileHealthEvent,
  type SockscapRuleSourceView,
  type SockscapStatsSnapshot,
  type SockscapTestEgressRequest,
  type SockscapTestEgressResult,
} from "../lib/sockscap";

export type SockscapSection = "overview" | "profiles" | "rules" | "dashboard" | "lifecycle";
export type SockscapLifecycleAction = "start" | "stop" | "recover";
export type SockscapProfileAction = "save" | "delete" | "test_egress";

interface SockscapStoreState {
  section: SockscapSection;
  initialized: boolean;
  loading: boolean;
  actionPending: SockscapLifecycleAction | null;
  profileActionPending: SockscapProfileAction | null;
  error: string | null;
  lastUpdatedAt: number | null;
  capabilities: SockscapCapabilitiesReport | null;
  status: SockscapEngineStatus | null;
  profiles: SockscapPersistedRoutingProfile[];
  processes: SockscapProcessCatalog | null;
  egressSessions: SockscapEgressSessionSummary[];
  ruleSources: SockscapRuleSourceView[];
  stats: SockscapStatsSnapshot | null;
  alerts: SockscapAlertEvent[];
  profileHealth: Record<string, SockscapProfileHealthEvent>;
  egressHealth: Record<string, SockscapTestEgressResult>;
  setSection: (section: SockscapSection) => void;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  loadProcesses: () => Promise<void>;
  saveProfile: (
    profile: SockscapPersistedRoutingProfile["profile"],
    expectedRevision: number,
  ) => Promise<SockscapPersistedRoutingProfile>;
  deleteProfile: (profileId: string, expectedRevision: number) => Promise<void>;
  testEgress: (request: SockscapTestEgressRequest) => Promise<SockscapTestEgressResult>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  recover: () => Promise<void>;
  dismissError: () => void;
  dismissAlert: (createdAtUnix: number, code: string) => void;
  reset: () => void;
}

const initialData = {
  section: "overview" as SockscapSection,
  initialized: false,
  loading: false,
  actionPending: null,
  profileActionPending: null,
  error: null,
  lastUpdatedAt: null,
  capabilities: null,
  status: null,
  profiles: [] as SockscapPersistedRoutingProfile[],
  processes: null as SockscapProcessCatalog | null,
  egressSessions: [] as SockscapEgressSessionSummary[],
  ruleSources: [] as SockscapRuleSourceView[],
  stats: null as SockscapStatsSnapshot | null,
  alerts: [] as SockscapAlertEvent[],
  profileHealth: {} as Record<string, SockscapProfileHealthEvent>,
  egressHealth: {} as Record<string, SockscapTestEgressResult>,
};

let refreshSequence = 0;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function settledError(result: PromiseSettledResult<unknown>): string | null {
  return result.status === "rejected" ? errorMessage(result.reason) : null;
}

export const useSockscapStore = create<SockscapStoreState>((set, get) => ({
  ...initialData,
  setSection: (section) => set({ section }),
  initialize: async () => {
    if (get().initialized || get().loading) return;
    await get().refresh();
  },
  refresh: async () => {
    const sequence = ++refreshSequence;
    set({ loading: true, error: null });
    const now = Math.floor(Date.now() / 1000);
    const results = await Promise.allSettled([
      sockscapCapabilities(),
      sockscapStatus(),
      sockscapListProfiles(),
      sockscapListEgressSessions(),
      sockscapListRuleSources(),
      sockscapStatsSnapshot({
        fromUnix: now - 24 * 60 * 60,
        toUnix: now,
        includeDomains: false,
        limit: 1440,
      }),
    ] as const);
    if (sequence !== refreshSequence) return;
    const [capabilities, status, profiles, egressSessions, ruleSources, stats] = results;
    const errors = results.map(settledError).filter((value): value is string => value !== null);
    set((current) => ({
      loading: false,
      initialized: true,
      lastUpdatedAt: Date.now(),
      error: errors.length > 0 ? errors.join("; ") : null,
      capabilities: capabilities.status === "fulfilled" ? capabilities.value : current.capabilities,
      status: status.status === "fulfilled" ? status.value : current.status,
      profiles: profiles.status === "fulfilled" ? profiles.value : current.profiles,
      egressSessions: egressSessions.status === "fulfilled" ? egressSessions.value : current.egressSessions,
      ruleSources: ruleSources.status === "fulfilled" ? ruleSources.value : current.ruleSources,
      stats: stats.status === "fulfilled" ? stats.value : current.stats,
    }));
  },
  loadProcesses: async () => {
    try {
      const processes = await sockscapListProcesses();
      set({ processes, error: null });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },
  saveProfile: async (profile, expectedRevision) => {
    set({ profileActionPending: "save", error: null });
    try {
      const saved = await sockscapUpsertProfile(profile, expectedRevision);
      set((current) => ({
        profileActionPending: null,
        profiles: sortProfiles([
          ...current.profiles.filter((record) => record.profile.id !== saved.profile.id),
          saved,
        ]),
      }));
      return saved;
    } catch (error) {
      set({ profileActionPending: null, error: errorMessage(error) });
      throw error;
    }
  },
  deleteProfile: async (profileId, expectedRevision) => {
    set({ profileActionPending: "delete", error: null });
    try {
      await sockscapDeleteProfile(profileId, expectedRevision);
      set((current) => ({
        profileActionPending: null,
        profiles: current.profiles.filter((record) => record.profile.id !== profileId),
      }));
    } catch (error) {
      set({ profileActionPending: null, error: errorMessage(error) });
      throw error;
    }
  },
  testEgress: async (request) => {
    set({ profileActionPending: "test_egress", error: null });
    try {
      const result = await sockscapTestEgress(request);
      set((current) => ({
        profileActionPending: null,
        egressHealth: { ...current.egressHealth, [result.summary.id]: result },
      }));
      return result;
    } catch (error) {
      set({ profileActionPending: null, error: errorMessage(error) });
      throw error;
    }
  },
  start: async () => runLifecycle(set, "start", sockscapStart),
  stop: async () => runLifecycle(set, "stop", sockscapStop),
  recover: async () => runLifecycle(set, "recover", sockscapRecover),
  dismissError: () => set({ error: null }),
  dismissAlert: (createdAtUnix, code) => set((current) => ({
    alerts: current.alerts.filter((alert) => alert.createdAtUnix !== createdAtUnix || alert.code !== code),
  })),
  reset: () => {
    refreshSequence += 1;
    set({ ...initialData });
  },
}));

function sortProfiles(profiles: SockscapPersistedRoutingProfile[]): SockscapPersistedRoutingProfile[] {
  return [...profiles].sort((left, right) => left.profile.priority - right.profile.priority
    || left.profile.name.localeCompare(right.profile.name)
    || left.profile.id.localeCompare(right.profile.id));
}

async function runLifecycle(
  set: (patch: Partial<SockscapStoreState>) => void,
  action: SockscapLifecycleAction,
  command: () => Promise<SockscapEngineStatus>,
): Promise<void> {
  set({ actionPending: action, error: null });
  try {
    const status = await command();
    set({ status, actionPending: null });
  } catch (error) {
    set({ actionPending: null, error: errorMessage(error) });
    try {
      set({ status: await sockscapStatus() });
    } catch {
      // The original lifecycle error is more actionable than a follow-up status failure.
    }
  }
}

/**
 * Connect Tauri events to the Zustand snapshot. Each caller gets independent
 * cleanup, including the React StrictMode setup/teardown race.
 */
export function attachSockscapEventBridge(): () => void {
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  const subscribe = (promise: Promise<() => void>) => {
    void promise
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.push(unlisten);
      })
      .catch((error) => {
        if (!disposed) useSockscapStore.setState({ error: errorMessage(error) });
      });
  };

  subscribe(listenSockscapStatus((status) => useSockscapStore.setState({ status })));
  subscribe(listenSockscapTrafficSummary((event) => useSockscapStore.setState((current) => {
    if (!current.stats) return {};
    return {
      stats: {
        ...current.stats,
        generatedAt: event.generatedAtUnix,
        totals: event.totals,
        series: event.cleared ? [] : current.stats.series,
        topApplications: event.cleared ? [] : current.stats.topApplications,
        topDomains: event.cleared ? [] : current.stats.topDomains,
        egressHealth: event.cleared ? [] : current.stats.egressHealth,
      },
    };
  })));
  subscribe(listenSockscapProfileHealth((event) => useSockscapStore.setState((current) => ({
    profileHealth: { ...current.profileHealth, [event.profileId]: event },
  }))));
  subscribe(listenSockscapEgressHealth((event) => useSockscapStore.setState((current) => ({
    egressHealth: { ...current.egressHealth, [event.summary.id]: event },
  }))));
  subscribe(listenSockscapAlert((event) => useSockscapStore.setState((current) => ({
    alerts: [event, ...current.alerts].slice(0, 50),
  }))));

  return () => {
    disposed = true;
    for (const unlisten of unlisteners.splice(0)) unlisten();
  };
}
