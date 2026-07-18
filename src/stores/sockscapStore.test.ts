import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SockscapPersistedRoutingProfile } from "../lib/sockscap";

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  status: vi.fn(),
  profiles: vi.fn(),
  processes: vi.fn(),
  egress: vi.fn(),
  rules: vi.fn(),
  stats: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  recover: vi.fn(),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
  testEgress: vi.fn(),
  saveRuleSource: vi.fn(),
  deleteRuleSource: vi.fn(),
  refreshRuleSource: vi.fn(),
  importRuleSource: vi.fn(),
  testTarget: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
  unlisten: vi.fn(),
}));

vi.mock("../lib/sockscap", () => ({
  sockscapCapabilities: mocks.capabilities,
  sockscapStatus: mocks.status,
  sockscapListProfiles: mocks.profiles,
  sockscapListProcesses: mocks.processes,
  sockscapListEgressSessions: mocks.egress,
  sockscapListRuleSources: mocks.rules,
  sockscapStatsSnapshot: mocks.stats,
  sockscapStart: mocks.start,
  sockscapStop: mocks.stop,
  sockscapRecover: mocks.recover,
  sockscapUpsertProfile: mocks.saveProfile,
  sockscapDeleteProfile: mocks.deleteProfile,
  sockscapTestEgress: mocks.testEgress,
  sockscapUpsertRuleSource: mocks.saveRuleSource,
  sockscapDeleteRuleSource: mocks.deleteRuleSource,
  sockscapRefreshRuleSource: mocks.refreshRuleSource,
  sockscapImportRuleSource: mocks.importRuleSource,
  sockscapTestTarget: mocks.testTarget,
  listenSockscapStatus: (callback: (payload: unknown) => void) => {
    mocks.listeners.set("status", callback);
    return Promise.resolve(mocks.unlisten);
  },
  listenSockscapTrafficSummary: (callback: (payload: unknown) => void) => {
    mocks.listeners.set("traffic", callback);
    return Promise.resolve(mocks.unlisten);
  },
  listenSockscapProfileHealth: (callback: (payload: unknown) => void) => {
    mocks.listeners.set("profile", callback);
    return Promise.resolve(mocks.unlisten);
  },
  listenSockscapEgressHealth: (callback: (payload: unknown) => void) => {
    mocks.listeners.set("egress", callback);
    return Promise.resolve(mocks.unlisten);
  },
  listenSockscapAlert: (callback: (payload: unknown) => void) => {
    mocks.listeners.set("alert", callback);
    return Promise.resolve(mocks.unlisten);
  },
}));

import { attachSockscapEventBridge, useSockscapStore } from "./sockscapStore";

const status = {
  state: "disabled",
  message: "disabled",
  activeProfileIds: [],
  lastError: null,
  recoveryRequired: false,
  captureActive: false,
};

const totals = {
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

describe("Sockscap store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    useSockscapStore.getState().reset();
    mocks.capabilities.mockResolvedValue({
      platform: "linux",
      items: [],
      canStartGlobal: true,
      canStartAppGroup: true,
      canAttachPid: true,
      summary: "ready",
      captureImplemented: true,
    });
    mocks.status.mockResolvedValue(status);
    mocks.profiles.mockResolvedValue([]);
    mocks.processes.mockResolvedValue({ processes: [], truncated: false, maxRows: 4096 });
    mocks.egress.mockResolvedValue([]);
    mocks.rules.mockResolvedValue([]);
    mocks.stats.mockResolvedValue({
      generatedAt: 1,
      fromUnix: 0,
      toUnix: 1,
      totals,
      series: [],
      topApplications: [],
      topDomains: [],
      egressHealth: [],
    });
    mocks.deleteProfile.mockResolvedValue(undefined);
    mocks.deleteRuleSource.mockResolvedValue(undefined);
  });

  it("hydrates independent snapshots while preserving partial successes", async () => {
    mocks.egress.mockRejectedValueOnce(new Error("Vault unavailable"));
    await useSockscapStore.getState().initialize();
    const state = useSockscapStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.capabilities?.platform).toBe("linux");
    expect(state.status?.state).toBe("disabled");
    expect(state.stats?.totals.connections).toBe(0);
    expect(state.error).toContain("Vault unavailable");
  });

  it("refreshes the authoritative status after a lifecycle command fails", async () => {
    mocks.start.mockRejectedValueOnce(new Error("SOCKSCAP_PREFLIGHT_FAILED: capture unavailable"));
    mocks.status.mockResolvedValueOnce({ ...status, lastError: "capture unavailable" });
    await useSockscapStore.getState().start();
    const state = useSockscapStore.getState();
    expect(state.actionPending).toBeNull();
    expect(state.error).toContain("SOCKSCAP_PREFLIGHT_FAILED");
    expect(state.status?.lastError).toBe("capture unavailable");
  });

  it("bridges typed aggregate events and cleans up StrictMode races", async () => {
    useSockscapStore.setState({
      stats: {
        generatedAt: 1,
        fromUnix: 0,
        toUnix: 1,
        totals,
        series: [],
        topApplications: [],
        topDomains: [],
        egressHealth: [],
      },
    });
    const detach = attachSockscapEventBridge();
    await Promise.resolve();
    mocks.listeners.get("status")?.({ ...status, state: "active", captureActive: true });
    mocks.listeners.get("traffic")?.({
      generatedAtUnix: 2,
      totals: { ...totals, connections: 3 },
      cleared: false,
    });
    mocks.listeners.get("alert")?.({
      code: "TEST_ALERT",
      message: "test",
      severity: "error",
      createdAtUnix: 2,
    });
    expect(useSockscapStore.getState().status?.state).toBe("active");
    expect(useSockscapStore.getState().stats?.totals.connections).toBe(3);
    expect(useSockscapStore.getState().alerts[0].code).toBe("TEST_ALERT");
    detach();
    expect(mocks.unlisten).toHaveBeenCalledTimes(5);
  });

  it("applies optimistic profile saves and deletes to the ordered snapshot", async () => {
    const first: SockscapPersistedRoutingProfile = {
      profile: {
        id: "profile-b",
        name: "B",
        enabled: false,
        priority: 20,
        scope: "global",
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
      },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const second: SockscapPersistedRoutingProfile = {
      ...first,
      profile: { ...first.profile, id: "profile-a", name: "A", priority: 10 },
    };
    useSockscapStore.setState({ profiles: [first] });
    mocks.saveProfile.mockResolvedValueOnce(second);
    await useSockscapStore.getState().saveProfile(second.profile, 0);
    expect(mocks.saveProfile).toHaveBeenCalledWith(second.profile, 0);
    expect(useSockscapStore.getState().profiles.map((record) => record.profile.id)).toEqual([
      "profile-a",
      "profile-b",
    ]);
    await useSockscapStore.getState().deleteProfile("profile-a", 1);
    expect(mocks.deleteProfile).toHaveBeenCalledWith("profile-a", 1);
    expect(useSockscapStore.getState().profiles).toEqual([first]);
  });

  it("keeps last-good rule source views after refresh and exposes authoritative target decisions", async () => {
    const sourceView = {
      record: {
        source: {
          id: "source-a",
          name: "A",
          enabled: true,
          kind: "custom_url" as const,
          url: "https://rules.example/list.txt",
          refreshIntervalSeconds: 21_600,
        },
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      state: null,
    };
    useSockscapStore.setState({ ruleSources: [sourceView] });
    mocks.refreshRuleSource.mockResolvedValueOnce({
      ok: false,
      usedLastGood: true,
      notModified: false,
      mirror: "https://rules.example/list.txt",
      sha256: "abc",
      parseStats: null,
      error: "network timeout",
      report: null,
    });
    mocks.rules.mockResolvedValueOnce([{ ...sourceView, state: { sourceId: "source-a", lastError: "network timeout" } }]);
    const outcome = await useSockscapStore.getState().refreshRuleSource("source-a");
    expect(outcome.usedLastGood).toBe(true);
    expect(useSockscapStore.getState().ruleSources[0].state?.lastError).toBe("network timeout");

    const decision = {
      selectedProfileId: "profile-a",
      selectedProfileName: "A",
      selectionReason: "application selector",
      decision: {
        action: "proxy" as const,
        matchedRuleOriginal: "||example.com",
        matchedRuleSourceId: "source-a",
        matchedStage: "subscription_proxy",
        hostnameSource: "tls_sni" as const,
        profileId: "profile-a",
      },
      conflicts: [],
      notes: [],
    };
    mocks.testTarget.mockResolvedValueOnce(decision);
    await expect(useSockscapStore.getState().testTarget({
      appIdentity: null,
      appSelectorKind: null,
      pid: null,
      processStartTime: null,
      hostname: "example.com",
      ip: null,
      port: 443,
      protocol: "tcp",
      hostnameSource: "tls_sni",
      hardBypass: false,
    })).resolves.toEqual(decision);
  });
});
