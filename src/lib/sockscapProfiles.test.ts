import { describe, expect, it } from "vitest";
import {
  changeSockscapProfileScope,
  createSockscapProfileDraft,
  createSockscapProfileId,
  selectSockscapEgress,
  sockscapScopeSupported,
  validateSockscapProfileDraft,
} from "./sockscapProfiles";

describe("Sockscap profile drafts", () => {
  it("creates safe disabled drafts that mirror Rust defaults", () => {
    const profile = createSockscapProfileDraft(createSockscapProfileId(10, 0.5), "Browser routing");
    expect(profile.id).toMatch(/^profile-[A-Za-z0-9-]+$/);
    expect(profile.enabled).toBe(false);
    expect(profile.scope).toBe("applications");
    expect(profile.sshPoolOptions.maxChannelsPerConnection).toBe(128);
    expect(profile.statsPrivacy.domainAggregationEnabled).toBe(false);
    expect(validateSockscapProfileDraft(profile, null)).toEqual([]);
  });

  it("clears selectors when scope changes and preserves PID reuse guards", () => {
    const profile = createSockscapProfileDraft("profile-a", "A");
    profile.appSelectors = [{ kind: "executable_path", value: "/usr/bin/browser" }];
    profile.runtimeProcesses = [{ pid: 41, processStartTime: 99 }];
    const runtime = changeSockscapProfileScope(profile, "runtime_processes");
    expect(runtime.appSelectors).toEqual([]);
    expect(runtime.runtimeProcesses).toEqual([{ pid: 41, processStartTime: 99 }]);
    expect(changeSockscapProfileScope(runtime, "global").runtimeProcesses).toEqual([]);
  });

  it("selects typed egress and forces TCP-only UDP policy to block", () => {
    const profile = createSockscapProfileDraft("profile-a", "A");
    profile.udpPolicy = "direct";
    const next = selectSockscapEgress(profile, {
      id: "ssh-1",
      name: "Jump",
      kind: "ssh_jump",
      protocol: "ssh_jump",
      endpointHost: "jump.example",
      endpointPort: 22,
      authKind: "agent",
      remoteDns: true,
      tcpOnly: true,
      availability: "ready",
      issue: null,
    });
    expect(next.egressKind).toBe("ssh_jump");
    expect(next.egressRefId).toBe("ssh-1");
    expect(next.udpPolicy).toBe("block");
  });

  it("reports enabled selector, upstream, and privacy validation errors", () => {
    const profile = createSockscapProfileDraft("profile-a", " A ");
    profile.enabled = true;
    profile.defaultAction = "proxy";
    profile.statsPrivacy.domainAggregationEnabled = true;
    profile.statsPrivacy.domainRetentionDays = 0;
    expect(validateSockscapProfileDraft(profile, null).map((issue) => issue.field)).toEqual([
      "name",
      "appSelectors",
      "egress",
      "statsPrivacy",
    ]);
  });

  it("maps each scope to the authoritative capability flag", () => {
    const capabilities = {
      platform: "linux" as const,
      items: [],
      canStartGlobal: true,
      canStartAppGroup: false,
      canAttachPid: false,
      summary: "global only",
      captureImplemented: true,
    };
    expect(sockscapScopeSupported(capabilities, "global")).toBe(true);
    expect(sockscapScopeSupported(capabilities, "applications")).toBe(false);
    expect(sockscapScopeSupported(capabilities, "runtime_processes")).toBe(false);
  });
});
