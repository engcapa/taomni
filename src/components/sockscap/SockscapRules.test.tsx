import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSockscapProfileDraft } from "../../lib/sockscapProfiles";

const mocks = vi.hoisted(() => ({
  saveRuleSource: vi.fn(),
  deleteRuleSource: vi.fn(),
  refreshRuleSource: vi.fn(),
  importRuleSource: vi.fn(),
  saveProfile: vi.fn(),
  testTarget: vi.fn(),
  state: {} as Record<string, unknown>,
}));

vi.mock("../../stores/sockscapStore", () => ({
  useSockscapStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
}));

import { SockscapRules } from "./SockscapRules";

describe("SockscapRules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const profile = createSockscapProfileDraft("profile-browser", "Browser");
    profile.scope = "global";
    const source = {
      id: "gfwlist-official",
      name: "GFWList (official)",
      enabled: true,
      kind: "gfwlist_official" as const,
      url: null,
      refreshIntervalSeconds: 86_400,
    };
    mocks.state = {
      ruleSources: [{
        record: { source, revision: 1, createdAt: 1, updatedAt: 1 },
        state: {
          sourceId: source.id,
          kind: source.kind,
          url: null,
          lastGoodPath: null,
          lastSuccessUnix: 10,
          lastMirror: "https://mirror.example/gfwlist.txt",
          lastSha256: "abcdef0123456789",
          etag: null,
          lastModified: null,
          refreshAfterUnix: 20,
          lastError: null,
          parseStats: { totalLines: 100, proxyRules: 70, directRules: 10, unsupported: 2, ignoredComments: 18 },
        },
      }],
      profiles: [{ profile, revision: 1, createdAt: 1, updatedAt: 1 }],
      egressSessions: [],
      ruleActionPending: null,
      profileActionPending: null,
      saveRuleSource: mocks.saveRuleSource,
      deleteRuleSource: mocks.deleteRuleSource,
      refreshRuleSource: mocks.refreshRuleSource,
      importRuleSource: mocks.importRuleSource,
      saveProfile: mocks.saveProfile,
      testTarget: mocks.testTarget,
    };
    mocks.saveRuleSource.mockImplementation(async (nextSource) => ({
      source: nextSource,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }));
    mocks.saveProfile.mockImplementation(async (nextProfile) => ({
      profile: nextProfile,
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
    }));
    mocks.refreshRuleSource.mockResolvedValue({
      ok: false,
      usedLastGood: true,
      notModified: false,
      mirror: "https://mirror.example/gfwlist.txt",
      sha256: "abcdef0123456789",
      parseStats: null,
      error: "network timeout",
      report: null,
    });
    mocks.importRuleSource.mockResolvedValue({
      ok: true,
      usedLastGood: false,
      notModified: false,
      mirror: null,
      sha256: "1234567890abcdef",
      parseStats: { totalLines: 1, proxyRules: 1, directRules: 0, unsupported: 0, ignoredComments: 0 },
      error: null,
      report: {
        proxyRules: [{ action: "proxy", kind: "domain_suffix", pattern: "example.com", original: "||example.com", sourceId: "source-local" }],
        directRules: [],
        unsupported: [],
        ignoredComments: 0,
        totalLines: 1,
      },
    });
    mocks.testTarget.mockResolvedValue({
      selectedProfileId: "profile-browser",
      selectedProfileName: "Browser",
      selectionReason: "enabled global profile",
      decision: {
        action: "proxy",
        matchedRuleOriginal: "||youtube.com",
        matchedRuleSourceId: "gfwlist-official",
        matchedStage: "subscription_proxy",
        hostnameSource: "tls_sni",
        profileId: "profile-browser",
      },
      conflicts: [],
      notes: ["saved profiles and last-good caches only"],
    });
  });

  afterEach(cleanup);

  it("creates a custom URL source with optimistic revision zero", async () => {
    render(<SockscapRules />);
    await screen.findByTestId("sockscap-rule-source-name");
    fireEvent.click(screen.getByTestId("sockscap-rule-source-new-url"));
    fireEvent.change(await screen.findByTestId("sockscap-rule-source-url"), {
      target: { value: "https://rules.example/list.txt" },
    });
    fireEvent.click(screen.getByTestId("sockscap-rule-source-save"));
    await waitFor(() => expect(mocks.saveRuleSource).toHaveBeenCalledTimes(1));
    expect(mocks.saveRuleSource).toHaveBeenCalledWith(expect.objectContaining({
      kind: "custom_url",
      url: "https://rules.example/list.txt",
      refreshIntervalSeconds: 21_600,
    }), 0);
  });

  it("shows that a failed official refresh preserved last-good", async () => {
    render(<SockscapRules />);
    await screen.findByTestId("sockscap-rule-source-state");
    fireEvent.click(screen.getByTestId("sockscap-rule-source-refresh"));
    await waitFor(() => expect(mocks.refreshRuleSource).toHaveBeenCalledWith("gfwlist-official"));
    expect(await screen.findByTestId("sockscap-refresh-report")).toHaveTextContent(/last-good/i);
    expect(screen.getByText("network timeout")).toBeInTheDocument();
  });

  it("imports payload contents into a saved local source without a file path", async () => {
    render(<SockscapRules />);
    await screen.findByTestId("sockscap-rule-source-name");
    fireEvent.click(screen.getByTestId("sockscap-rule-source-new-local"));
    fireEvent.click(await screen.findByTestId("sockscap-rule-source-save"));
    await waitFor(() => expect(mocks.saveRuleSource).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("sockscap-rule-payload"), { target: { value: "||example.com" } });
    fireEvent.click(screen.getByTestId("sockscap-rule-source-import"));
    await waitFor(() => expect(mocks.importRuleSource).toHaveBeenCalledTimes(1));
    expect(mocks.importRuleSource.mock.calls[0][1]).toBe("||example.com");
    expect(mocks.importRuleSource.mock.calls[0][0]).toMatch(/^source-/);
  });

  it("persists ordered first-match manual overrides through profile revision control", async () => {
    render(<SockscapRules />);
    const add = await screen.findByTestId("sockscap-manual-rule-add");
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.change(screen.getByTestId("sockscap-manual-rule-pattern-0"), { target: { value: "example.com" } });
    fireEvent.change(screen.getByTestId("sockscap-manual-rule-pattern-1"), { target: { value: "internal.example" } });
    fireEvent.click(screen.getAllByLabelText("Move rule earlier")[1]);
    fireEvent.click(screen.getByTestId("sockscap-manual-rules-save"));
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(1));
    expect(mocks.saveProfile.mock.calls[0][0].customRules).toEqual([
      expect.objectContaining({ enabled: true, action: "direct", kind: "domain_suffix", pattern: "internal.example" }),
      expect.objectContaining({ enabled: true, action: "direct", kind: "domain_suffix", pattern: "example.com" }),
    ]);
    expect(mocks.saveProfile.mock.calls[0][1]).toBe(1);
  });

  it("submits only the public synthetic-flow target contract and explains the decision", async () => {
    render(<SockscapRules />);
    const target = await screen.findByTestId("sockscap-target-host");
    fireEvent.change(target, { target: { value: "youtube.com" } });
    fireEvent.click(screen.getByTestId("sockscap-target-run"));
    await waitFor(() => expect(mocks.testTarget).toHaveBeenCalledTimes(1));
    const request = mocks.testTarget.mock.calls[0][0] as Record<string, unknown>;
    expect(request).toEqual(expect.objectContaining({ hostname: "youtube.com", ip: null, port: 443 }));
    expect(request).not.toHaveProperty("profiles");
    expect(request).not.toHaveProperty("matchers");
    const result = await screen.findByTestId("sockscap-target-result");
    expect(result).toHaveTextContent("PROXY");
    expect(result).toHaveTextContent("||youtube.com");
  });
});
