import { beforeEach, describe, expect, it, vi } from "vitest";
import contractFixtureJson from "../test/fixtures/sockscap-ipc-contract.json?raw";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

import {
  SOCKSCAP_EVENTS,
  isSockscapIpcContractFixture,
  listenSockscapTrafficSummary,
  sockscapDeleteProfile,
  sockscapStatsSnapshot,
  sockscapTestEgress,
  sockscapTestTarget,
  sockscapUpsertProfile,
  type SockscapRoutingProfileDraft,
  type SockscapTestTargetRequest,
} from "./sockscap";

const profile = (): SockscapRoutingProfileDraft => ({
  id: "profile-1",
  name: "Profile 1",
  enabled: true,
  priority: 100,
  scope: "applications",
  appSelectors: [{ kind: "executable_path", value: "/usr/bin/browser" }],
  runtimeProcesses: [],
  includeChildren: true,
  egressKind: "proxy_session",
  egressRefId: "proxy-1",
  egressFailureAction: "fail_open",
  sshPoolOptions: {
    maxControlConnections: 2,
    maxChannelsPerConnection: 128,
    keepaliveSeconds: 30,
    connectTimeoutSeconds: 15,
  },
  ruleSourceIds: [],
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
});

describe("Sockscap IPC contract", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it("accepts the same representative camelCase fixture as Rust", () => {
    const fixture: unknown = JSON.parse(contractFixtureJson);
    expect(isSockscapIpcContractFixture(fixture)).toBe(true);
    if (!isSockscapIpcContractFixture(fixture)) throw new Error("invalid fixture");
    expect(fixture.profile.profile.sshPoolOptions.maxChannelsPerConnection).toBe(64);
    expect(fixture.ruleSource.state?.lastGoodPath).toBeNull();
    expect(fixture.egressSession).not.toHaveProperty("username");
    expect(fixture.egressSession).not.toHaveProperty("password");
  });

  it("uses exact Tauri argument names for optimistic profile writes", async () => {
    const draft = profile();
    mocks.invoke.mockResolvedValueOnce({ profile: draft, revision: 4, createdAt: 1, updatedAt: 2 });
    await sockscapUpsertProfile(draft, 3);
    expect(mocks.invoke).toHaveBeenCalledWith("sockscap_upsert_profile", {
      profile: draft,
      expectedRevision: 3,
    });

    mocks.invoke.mockResolvedValueOnce(undefined);
    await sockscapDeleteProfile("profile-1", 4);
    expect(mocks.invoke).toHaveBeenCalledWith("sockscap_delete_profile", {
      profileId: "profile-1",
      expectedRevision: 4,
    });
  });

  it("never exposes caller-owned profiles or matchers in the test-target request", async () => {
    const request: SockscapTestTargetRequest = {
      appIdentity: "/usr/bin/browser",
      appSelectorKind: "executable_path",
      pid: null,
      processStartTime: null,
      hostname: "blocked.example",
      ip: null,
      port: 443,
      protocol: "tcp",
      hostnameSource: "tls_sni",
      hardBypass: false,
    };
    mocks.invoke.mockResolvedValueOnce({
      selectedProfileId: null,
      selectedProfileName: null,
      selectionReason: "none",
      decision: null,
      conflicts: [],
      notes: [],
    });
    await sockscapTestTarget(request);
    expect(mocks.invoke).toHaveBeenCalledWith("sockscap_test_target", { request });
    const sent = mocks.invoke.mock.calls[0][1].request as Record<string, unknown>;
    expect(sent).not.toHaveProperty("profiles");
    expect(sent).not.toHaveProperty("matchers");
  });

  it("keeps egress diagnostics and stats queries nested under their Rust request names", async () => {
    const request = {
      sessionId: "ssh-1",
      targetHost: "example.com",
      targetPort: 443,
      timeoutMillis: 15_000,
      interactive: true,
      sshPoolOptions: {
        maxControlConnections: 2,
        maxChannelsPerConnection: 64,
        keepaliveSeconds: 30,
        connectTimeoutSeconds: 15,
      },
    } as const;
    mocks.invoke.mockResolvedValueOnce({});
    await sockscapTestEgress(request);
    expect(mocks.invoke).toHaveBeenCalledWith("sockscap_test_egress", { request });

    const query = { fromUnix: 1, toUnix: 2, includeDomains: false, limit: 100 };
    mocks.invoke.mockResolvedValueOnce({});
    await sockscapStatsSnapshot(query);
    expect(mocks.invoke).toHaveBeenCalledWith("sockscap_stats_snapshot", { query });
  });

  it("unwraps typed Tauri event payloads", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockImplementationOnce(async (_name, callback) => {
      callback({
        event: SOCKSCAP_EVENTS.trafficSummary,
        id: 1,
        windowLabel: "main",
        payload: {
          generatedAtUnix: 123,
          totals: {
            bytesUp: 1,
            bytesDown: 2,
            connections: 1,
            errors: 0,
            directConnections: 0,
            proxyConnections: 1,
            blockedConnections: 0,
            unknownHostnameConnections: 0,
            connectMillisTotal: 5,
          },
          cleared: false,
        },
      });
      return unlisten;
    });
    const handler = vi.fn();
    await expect(listenSockscapTrafficSummary(handler)).resolves.toBe(unlisten);
    expect(mocks.listen).toHaveBeenCalledWith(SOCKSCAP_EVENTS.trafficSummary, expect.any(Function));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ generatedAtUnix: 123, cleared: false }));
  });
});
