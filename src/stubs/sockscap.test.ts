import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SockscapLiveConnectionsSnapshot,
  SockscapLifecycleSnapshot,
  SockscapPersistedRoutingProfile,
  SockscapTestEgressResult,
} from "../lib/sockscap";
import { listen } from "./tauri-event";
import { invokeSockscapStub, sockscapStubController } from "./sockscap";

async function invokeValue<T>(command: string, args?: unknown): Promise<T> {
  const result = await invokeSockscapStub(command, args);
  if (!result.handled) throw new Error(`unhandled test command: ${command}`);
  return result.value as T;
}

describe("Sockscap browser stub", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    await sockscapStubController.reset();
  });

  afterEach(async () => {
    await invokeValue("sockscap_stop");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["windows", "macos", "linux"] as const)("provides a controllable %s capability report", async (platform) => {
    await sockscapStubController.configure({ platform, capabilityMode: "supported" });
    const report = await invokeValue<Record<string, unknown>>("sockscap_capabilities");
    expect(report).toMatchObject({
      platform,
      canStartGlobal: true,
      canStartAppGroup: true,
      canAttachPid: true,
      captureImplemented: true,
    });

    await sockscapStubController.configure({ capabilityMode: "permission_required" });
    await expect(invokeValue<Record<string, unknown>>("sockscap_capabilities")).resolves.toMatchObject({
      platform,
      canStartGlobal: false,
      captureImplemented: true,
    });
  });

  it("switches Proxy and SSH health without exposing credentials", async () => {
    await sockscapStubController.configure({
      proxyHealth: "degraded",
      sshHealth: "user_action_required",
    });
    const sessions = await invokeValue<Array<Record<string, unknown>>>("sockscap_list_egress_sessions");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).not.toHaveProperty("username");
    expect(sessions[0]).not.toHaveProperty("password");

    const ssh = await invokeValue<SockscapTestEgressResult>("sockscap_test_egress", {
      request: {
        sessionId: "stub-ssh",
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
      },
    });
    expect(ssh).toMatchObject({
      ok: false,
      summary: { availability: "user_action_required" },
      issue: { code: "SSH_MFA_REQUIRED", userActionRequired: true },
      sshPool: { state: "user_action_required" },
    });
  });

  it("supports optimistic profile CRUD and rejects conflicting revisions", async () => {
    const profiles = await invokeValue<SockscapPersistedRoutingProfile[]>("sockscap_list_profiles");
    const current = profiles[0];
    const updated = {
      ...current.profile,
      name: "Updated browser demo",
    };
    const saved = await invokeValue<SockscapPersistedRoutingProfile>("sockscap_upsert_profile", {
      profile: updated,
      expectedRevision: current.revision,
    });
    expect(saved.revision).toBe(current.revision + 1);
    expect(saved.profile.name).toBe("Updated browser demo");

    await expect(invokeValue("sockscap_upsert_profile", {
      profile: { ...updated, name: "Stale edit" },
      expectedRevision: current.revision,
    })).rejects.toThrow("PROFILE_REVISION_CONFLICT");
  });

  it("emits bounded aggregate traffic and clears it without any flow payload", async () => {
    const events: unknown[] = [];
    const unlisten = await listen("sockscap://traffic-summary", (event) => events.push(event.payload));
    await sockscapStubController.configure({ trafficMode: "steady", capabilityMode: "supported" });
    await invokeValue("sockscap_start");
    const emitted = await sockscapStubController.emitTraffic();
    expect(emitted).toMatchObject({
      cleared: false,
      totals: { bytesUp: 8192, bytesDown: 32768, connections: 2 },
    });
    expect(JSON.stringify(emitted)).not.toMatch(/payload|url|username|password/i);

    const snapshot = await invokeValue<Record<string, unknown>>("sockscap_stats_snapshot", {
      query: { fromUnix: 0, toUnix: Number.MAX_SAFE_INTEGER, includeDomains: false, limit: 100 },
    });
    expect(snapshot).toMatchObject({ totals: { connections: 2 }, topDomains: [] });

    const live = await invokeValue<SockscapLiveConnectionsSnapshot>("sockscap_live_connections", {
      query: { sinceUnix: null, limit: 50 },
    });
    expect(live).toMatchObject({ capacity: 256, droppedSamples: 0 });
    expect(live.samples).toHaveLength(2);
    expect(JSON.stringify(live.samples)).not.toMatch(/hostname["']|domain|application|executable|payload|url|username|password/i);

    const cleared = await invokeValue<{ removedRows: number; removedLiveSamples: number }>("sockscap_clear_stats");
    expect(cleared.removedRows).toBe(1);
    expect(cleared.removedLiveSamples).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ cleared: true, totals: { connections: 0 } });
    unlisten();
  });

  it("bounds recent flow outcomes and rejects unbounded queries", async () => {
    await sockscapStubController.configure({ trafficMode: "burst", capabilityMode: "supported" });
    await invokeValue("sockscap_start");
    for (let index = 0; index < 12; index += 1) await sockscapStubController.emitTraffic();
    const live = await invokeValue<SockscapLiveConnectionsSnapshot>("sockscap_live_connections", {
      query: { sinceUnix: 0, limit: 200 },
    });
    expect(live.samples).toHaveLength(200);
    expect(live.droppedSamples).toBeGreaterThan(0);
    expect(live.samples[0].sampleId).toBeGreaterThan(live.samples[199].sampleId);
    await expect(invokeValue("sockscap_live_connections", {
      query: { sinceUnix: null, limit: 201 },
    })).rejects.toThrow("LIVE_CONNECTIONS_INVALID_LIMIT");
  });

  it("automatically publishes at most one traffic summary per second", async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const unlisten = await listen("sockscap://traffic-summary", (event) => events.push(event.payload));
    await sockscapStubController.configure({ trafficMode: "steady", capabilityMode: "supported" });
    await invokeValue("sockscap_start");
    await vi.advanceTimersByTimeAsync(3_100);
    expect(events).toHaveLength(3);
    expect(events).toEqual(events.map(() => expect.objectContaining({ cleared: false })));
    unlisten();
  });

  it("simulates recovery-required startup and one-click recovery", async () => {
    await sockscapStubController.configure({ recoveryRequired: true });
    await expect(invokeValue("sockscap_start")).rejects.toThrow("RECOVERY_REQUIRED");
    await expect(invokeValue("sockscap_status")).resolves.toMatchObject({
      state: "recovery_required",
      recoveryRequired: true,
      captureActive: false,
    });
    await expect(invokeValue("sockscap_recover")).resolves.toMatchObject({
      state: "disabled",
      recoveryRequired: false,
    });
  });

  it("models opt-in login restore from only a successful committed snapshot", async () => {
    const initial = await invokeValue<SockscapLifecycleSnapshot>("sockscap_lifecycle_snapshot");
    expect(initial).toMatchObject({
      preferences: { restoreOnSystemLogin: false },
      systemLoginRegistered: false,
      autoRestoreStatusCode: "DISABLED_BY_USER",
      lastCommittedConfig: null,
    });

    const enabled = await invokeValue<SockscapLifecycleSnapshot>(
      "sockscap_set_restore_on_system_login",
      { enabled: true },
    );
    expect(enabled).toMatchObject({
      preferences: { restoreOnSystemLogin: true },
      systemLoginRegistered: true,
      autoRestoreStatusCode: "LAST_COMMITTED_CONFIG_MISSING",
    });

    await invokeValue("sockscap_start");
    const ready = await invokeValue<SockscapLifecycleSnapshot>("sockscap_lifecycle_snapshot");
    expect(ready.autoRestoreReady).toBe(true);
    expect(ready.lastCommittedConfig).toMatchObject({ profileIds: ["browser-demo"] });
    expect(ready.recovery).not.toHaveProperty("artifactState");
  });

  it("refuses login restore when the simulated capture adapter is unavailable", async () => {
    await sockscapStubController.configure({ capabilityMode: "unsupported" });
    await expect(invokeValue("sockscap_set_restore_on_system_login", { enabled: true }))
      .rejects.toThrow("CAPTURE_ADAPTER_NOT_READY");
  });

  it("opens the dedicated browser route and keeps active capture alive on close", async () => {
    const focus = vi.fn();
    const popup = { focus } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await invokeValue("sockscap_open_window");
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("sockscap=1"),
      "taomni-sockscap",
      "popup,width=1280,height=820",
    );
    expect(focus).toHaveBeenCalledTimes(1);

    await invokeValue("sockscap_start");
    await expect(invokeValue("sockscap_close_window")).resolves.toBe("hidden");
    expect(close).not.toHaveBeenCalled();
    await invokeValue("sockscap_stop");
    await expect(invokeValue("sockscap_close_window")).resolves.toBe("closed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
