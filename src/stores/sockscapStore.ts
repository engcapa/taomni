import { create } from "zustand";
import {
  listenSockscapAlert,
  listenSockscapEgressHealth,
  listenSockscapProfileHealth,
  listenSockscapStatus,
  listenSockscapTrafficSummary,
  sockscapCapabilities,
  sockscapClearStats,
  sockscapListEgressSessions,
  sockscapListProcesses,
  sockscapListProfiles,
  sockscapListRuleSources,
  sockscapLiveConnections,
  sockscapImportRuleSource,
  sockscapDeleteRuleSource,
  sockscapRecover,
  sockscapDeleteProfile,
  sockscapRefreshRuleSource,
  sockscapStart,
  sockscapStatsSnapshot,
  sockscapStatus,
  sockscapStop,
  sockscapTestEgress,
  sockscapTestTarget,
  sockscapUpsertProfile,
  sockscapUpsertRuleSource,
  type SockscapAlertEvent,
  type SockscapCapabilitiesReport,
  type SockscapClearStatsResult,
  type SockscapEgressSessionSummary,
  type SockscapEngineStatus,
  type SockscapLiveConnectionsSnapshot,
  type SockscapPersistedRoutingProfile,
  type SockscapProcessCatalog,
  type SockscapProfileHealthEvent,
  type SockscapPersistedRuleSource,
  type SockscapRefreshOutcome,
  type SockscapRuleSourceDraft,
  type SockscapRuleSourceView,
  type SockscapStatsSnapshot,
  type SockscapTestEgressRequest,
  type SockscapTestEgressResult,
  type SockscapTestTargetRequest,
  type SockscapTestTargetResult,
} from "../lib/sockscap";

export type SockscapSection = "overview" | "profiles" | "rules" | "dashboard" | "lifecycle";
export type SockscapLifecycleAction = "start" | "stop" | "recover";
export type SockscapProfileAction = "save" | "delete" | "test_egress";
export type SockscapRuleAction = "save_source" | "delete_source" | "refresh_source" | "import_source" | "test_target";
export type SockscapDashboardAction = "clear_stats";

interface SockscapStoreState {
  section: SockscapSection;
  initialized: boolean;
  loading: boolean;
  actionPending: SockscapLifecycleAction | null;
  profileActionPending: SockscapProfileAction | null;
  ruleActionPending: SockscapRuleAction | null;
  dashboardLoading: boolean;
  dashboardActionPending: SockscapDashboardAction | null;
  dashboardError: string | null;
  error: string | null;
  lastUpdatedAt: number | null;
  capabilities: SockscapCapabilitiesReport | null;
  status: SockscapEngineStatus | null;
  profiles: SockscapPersistedRoutingProfile[];
  processes: SockscapProcessCatalog | null;
  egressSessions: SockscapEgressSessionSummary[];
  ruleSources: SockscapRuleSourceView[];
  stats: SockscapStatsSnapshot | null;
  liveConnections: SockscapLiveConnectionsSnapshot | null;
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
  saveRuleSource: (source: SockscapRuleSourceDraft, expectedRevision: number) => Promise<SockscapPersistedRuleSource>;
  deleteRuleSource: (sourceId: string, expectedRevision: number) => Promise<void>;
  refreshRuleSource: (sourceId: string) => Promise<SockscapRefreshOutcome>;
  importRuleSource: (sourceId: string, payload: string) => Promise<SockscapRefreshOutcome>;
  testTarget: (request: SockscapTestTargetRequest) => Promise<SockscapTestTargetResult>;
  refreshDashboard: (rangeSeconds: number, includeDomains: boolean) => Promise<void>;
  clearStats: () => Promise<SockscapClearStatsResult>;
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
  ruleActionPending: null,
  dashboardLoading: false,
  dashboardActionPending: null,
  dashboardError: null,
  error: null,
  lastUpdatedAt: null,
  capabilities: null,
  status: null,
  profiles: [] as SockscapPersistedRoutingProfile[],
  processes: null as SockscapProcessCatalog | null,
  egressSessions: [] as SockscapEgressSessionSummary[],
  ruleSources: [] as SockscapRuleSourceView[],
  stats: null as SockscapStatsSnapshot | null,
  liveConnections: null as SockscapLiveConnectionsSnapshot | null,
  alerts: [] as SockscapAlertEvent[],
  profileHealth: {} as Record<string, SockscapProfileHealthEvent>,
  egressHealth: {} as Record<string, SockscapTestEgressResult>,
};

let refreshSequence = 0;
let dashboardSequence = 0;

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
        limit: 100,
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
      stats: stats.status === "fulfilled" && current.section !== "dashboard" ? stats.value : current.stats,
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
  saveRuleSource: async (source, expectedRevision) => {
    set({ ruleActionPending: "save_source", error: null });
    try {
      const saved = await sockscapUpsertRuleSource(source, expectedRevision);
      set((current) => {
        const previous = current.ruleSources.find((view) => view.record.source.id === saved.source.id);
        return {
          ruleActionPending: null,
          ruleSources: sortRuleSources([
            ...current.ruleSources.filter((view) => view.record.source.id !== saved.source.id),
            { record: saved, state: previous?.state ?? null },
          ]),
        };
      });
      return saved;
    } catch (error) {
      set({ ruleActionPending: null, error: errorMessage(error) });
      throw error;
    }
  },
  deleteRuleSource: async (sourceId, expectedRevision) => {
    set({ ruleActionPending: "delete_source", error: null });
    try {
      await sockscapDeleteRuleSource(sourceId, expectedRevision);
      set((current) => ({
        ruleActionPending: null,
        ruleSources: current.ruleSources.filter((view) => view.record.source.id !== sourceId),
      }));
    } catch (error) {
      set({ ruleActionPending: null, error: errorMessage(error) });
      throw error;
    }
  },
  refreshRuleSource: async (sourceId) => runRuleSourceUpdate(set, "refresh_source", () => sockscapRefreshRuleSource(sourceId)),
  importRuleSource: async (sourceId, payload) => runRuleSourceUpdate(set, "import_source", () => sockscapImportRuleSource(sourceId, payload)),
  testTarget: async (request) => {
    set({ ruleActionPending: "test_target", error: null });
    try {
      const result = await sockscapTestTarget(request);
      set({ ruleActionPending: null });
      return result;
    } catch (error) {
      set({ ruleActionPending: null, error: errorMessage(error) });
      throw error;
    }
  },
  refreshDashboard: async (rangeSeconds, includeDomains) => {
    const sequence = ++dashboardSequence;
    set({ dashboardLoading: true, dashboardError: null });
    const toUnix = Math.floor(Date.now() / 1000);
    const safeRangeSeconds = Number.isInteger(rangeSeconds)
      && rangeSeconds > 0
      && rangeSeconds <= 366 * 24 * 60 * 60
      ? rangeSeconds
      : 24 * 60 * 60;
    const fromUnix = Math.max(0, toUnix - safeRangeSeconds);
    const results = await Promise.allSettled([
      sockscapStatsSnapshot({
        fromUnix,
        toUnix,
        includeDomains,
        limit: 20,
      }),
      sockscapLiveConnections({ sinceUnix: fromUnix, limit: 100 }),
    ] as const);
    if (sequence !== dashboardSequence) return;
    const [stats, liveConnections] = results;
    const errors = results.map(settledError).filter((value): value is string => value !== null);
    set((current) => ({
      dashboardLoading: false,
      dashboardError: errors.length > 0 ? errors.join("; ") : null,
      stats: stats.status === "fulfilled" ? stats.value : current.stats,
      liveConnections: liveConnections.status === "fulfilled" ? liveConnections.value : current.liveConnections,
    }));
  },
  clearStats: async () => {
    dashboardSequence += 1;
    set({ dashboardLoading: false, dashboardActionPending: "clear_stats", dashboardError: null });
    try {
      const result = await sockscapClearStats();
      set((current) => ({
        dashboardActionPending: null,
        stats: current.stats ? {
          ...current.stats,
          generatedAt: Math.floor(Date.now() / 1000),
          totals: emptyStatsTotals(),
          series: [],
          topApplications: [],
          topDomains: [],
          egressHealth: [],
        } : null,
        liveConnections: current.liveConnections ? {
          ...current.liveConnections,
          generatedAtUnix: Math.floor(Date.now() / 1000),
          droppedSamples: 0,
          samples: [],
        } : null,
      }));
      return result;
    } catch (error) {
      set({ dashboardActionPending: null, dashboardError: errorMessage(error) });
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
    dashboardSequence += 1;
    set({ ...initialData });
  },
}));

function emptyStatsTotals(): SockscapStatsSnapshot["totals"] {
  return {
    bytesUp: 0,
    bytesDown: 0,
    connections: 0,
    errors: 0,
    directConnections: 0,
    proxyConnections: 0,
    blockedConnections: 0,
    unknownHostnameConnections: 0,
    connectMillisTotal: 0,
  };
}

function sortProfiles(profiles: SockscapPersistedRoutingProfile[]): SockscapPersistedRoutingProfile[] {
  return [...profiles].sort((left, right) => left.profile.priority - right.profile.priority
    || left.profile.name.localeCompare(right.profile.name)
    || left.profile.id.localeCompare(right.profile.id));
}

function sortRuleSources(sources: SockscapRuleSourceView[]): SockscapRuleSourceView[] {
  return [...sources].sort((left, right) => {
    const leftOfficial = left.record.source.kind === "gfwlist_official" ? 0 : 1;
    const rightOfficial = right.record.source.kind === "gfwlist_official" ? 0 : 1;
    return leftOfficial - rightOfficial
      || left.record.source.name.localeCompare(right.record.source.name)
      || left.record.source.id.localeCompare(right.record.source.id);
  });
}

async function runRuleSourceUpdate(
  set: (patch: Partial<SockscapStoreState> | ((state: SockscapStoreState) => Partial<SockscapStoreState>)) => void,
  action: Extract<SockscapRuleAction, "refresh_source" | "import_source">,
  command: () => Promise<SockscapRefreshOutcome>,
): Promise<SockscapRefreshOutcome> {
  set({ ruleActionPending: action, error: null });
  try {
    const outcome = await command();
    let refreshed: SockscapRuleSourceView[] | null = null;
    try {
      refreshed = await sockscapListRuleSources();
    } catch {
      // The refresh/import result remains authoritative even if the follow-up
      // view reload fails; the next normal window refresh will reconcile it.
    }
    set((current) => ({
      ruleActionPending: null,
      ruleSources: refreshed ? sortRuleSources(refreshed) : current.ruleSources,
    }));
    return outcome;
  } catch (error) {
    set({ ruleActionPending: null, error: errorMessage(error) });
    throw error;
  }
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
    if (!current.stats) {
      return {
        liveConnections: event.cleared && current.liveConnections ? {
          ...current.liveConnections,
          generatedAtUnix: event.generatedAtUnix,
          droppedSamples: 0,
          samples: [],
        } : current.liveConnections,
      };
    }
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
      liveConnections: event.cleared && current.liveConnections ? {
        ...current.liveConnections,
        generatedAtUnix: event.generatedAtUnix,
        droppedSamples: 0,
        samples: [],
      } : current.liveConnections,
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
