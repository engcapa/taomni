import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SockscapPersistedRoutingProfile, SockscapTestEgressResult } from "../lib/sockscap";
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

    const cleared = await invokeValue<{ removedRows: number }>("sockscap_clear_stats");
    expect(cleared.removedRows).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ cleared: true, totals: { connections: 0 } });
    unlisten();
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
});
