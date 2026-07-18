import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SockscapPersistedRoutingProfile } from "../../lib/sockscap";
import { createSockscapProfileDraft } from "../../lib/sockscapProfiles";

const mocks = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
  testEgress: vi.fn(),
  loadProcesses: vi.fn(async () => undefined),
  state: {} as Record<string, unknown>,
}));

vi.mock("../../stores/sockscapStore", () => ({
  useSockscapStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
}));

import { SockscapProfiles } from "./SockscapProfiles";

function savedProfile(): SockscapPersistedRoutingProfile {
  const profile = createSockscapProfileDraft("profile-browser", "Browser routing");
  profile.scope = "applications";
  return { profile, revision: 1, createdAt: 1, updatedAt: 1 };
}

describe("SockscapProfiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const record = savedProfile();
    mocks.state = {
      capabilities: {
        platform: "linux",
        items: [],
        canStartGlobal: true,
        canStartAppGroup: true,
        canAttachPid: true,
        summary: "Linux ready",
        captureImplemented: true,
      },
      profiles: [record],
      processes: {
        processes: [{
          pid: 4100,
          parentPid: 1,
          name: "Browser",
          executablePath: "/usr/bin/browser",
          processStartTime: 9988,
          selectable: true,
          rememberable: true,
          issueCode: null,
        }],
        truncated: false,
        maxRows: 4096,
      },
      egressSessions: [{
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
      }],
      ruleSources: [],
      profileActionPending: null,
      loadProcesses: mocks.loadProcesses,
      saveProfile: mocks.saveProfile,
      deleteProfile: mocks.deleteProfile,
      testEgress: mocks.testEgress,
    };
    mocks.saveProfile.mockImplementation(async (profile) => ({
      profile,
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
    }));
    mocks.deleteProfile.mockResolvedValue(undefined);
    mocks.testEgress.mockResolvedValue({
      ok: true,
      summary: (mocks.state.egressSessions as Array<Record<string, unknown>>)[0],
      elapsedMillis: 41,
      metadata: { connector: "ssh_jump", remoteDns: true, tcpOnly: true, detail: "ready" },
      issue: null,
      sshPool: null,
    });
  });

  afterEach(cleanup);

  it("saves a changed draft with its optimistic revision", async () => {
    render(<SockscapProfiles />);
    const name = await screen.findByTestId("sockscap-profile-name");
    fireEvent.change(name, { target: { value: "Browser routing v2" } });
    fireEvent.click(screen.getByTestId("sockscap-profile-save"));
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(1));
    expect(mocks.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "profile-browser", name: "Browser routing v2" }),
      1,
    );
  });

  it("creates a saveable disabled draft at revision zero", async () => {
    render(<SockscapProfiles />);
    await screen.findByTestId("sockscap-profile-name");
    fireEvent.click(screen.getByTestId("sockscap-profile-new"));
    const save = await screen.findByTestId("sockscap-profile-save");
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(1));
    expect(mocks.saveProfile.mock.calls[0][0]).toEqual(expect.objectContaining({
      enabled: false,
      priority: 100,
      scope: "applications",
    }));
    expect(mocks.saveProfile.mock.calls[0][1]).toBe(0);
  });

  it("remembers an executable identity and preserves runtime process start tokens", async () => {
    render(<SockscapProfiles />);
    await screen.findByTestId("sockscap-profile-name");
    fireEvent.click(screen.getByTestId("sockscap-pick-application"));
    fireEvent.click(screen.getByTestId("sockscap-process-4100"));
    expect(screen.getByText("/usr/bin/browser")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sockscap-scope-runtime_processes"));
    fireEvent.click(screen.getByTestId("sockscap-pick-runtime"));
    fireEvent.click(screen.getByTestId("sockscap-process-4100"));
    expect(screen.getByText(/PID 4100/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sockscap-profile-save"));
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(1));
    expect(mocks.saveProfile.mock.calls[0][0].runtimeProcesses).toEqual([
      { pid: 4100, processStartTime: 9988 },
    ]);
    expect(mocks.saveProfile.mock.calls[0][0].appSelectors).toEqual([]);
  });

  it("selects and tests a TCP-only SSH egress with bounded pool options", async () => {
    render(<SockscapProfiles />);
    await screen.findByTestId("sockscap-profile-name");
    fireEvent.change(screen.getByTestId("sockscap-egress-kind"), { target: { value: "ssh_jump" } });
    fireEvent.click(screen.getByTestId("sockscap-egress-test"));
    await waitFor(() => expect(mocks.testEgress).toHaveBeenCalledTimes(1));
    expect(mocks.testEgress).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "ssh-1",
      targetHost: "example.com",
      targetPort: 443,
      sshPoolOptions: expect.objectContaining({ maxChannelsPerConnection: 128 }),
    }));
    expect(await screen.findByText(/41 ms/)).toBeInTheDocument();
  });

  it("surfaces backend conflict errors without replacing the draft", async () => {
    mocks.saveProfile.mockRejectedValueOnce(new Error("PROFILE_CONFLICT: same-priority application selectors overlap"));
    render(<SockscapProfiles />);
    const name = await screen.findByTestId("sockscap-profile-name");
    fireEvent.change(name, { target: { value: "Conflicting profile" } });
    fireEvent.click(screen.getByTestId("sockscap-profile-save"));
    expect(await screen.findByText(/PROFILE_CONFLICT/)).toBeInTheDocument();
    expect(screen.getByTestId("sockscap-profile-name")).toHaveValue("Conflicting profile");
  });

  it("disables unsupported runtime selection from the capability report", async () => {
    (mocks.state.capabilities as Record<string, unknown>).canAttachPid = false;
    render(<SockscapProfiles />);
    await screen.findByTestId("sockscap-profile-name");
    expect(screen.getByTestId("sockscap-scope-runtime_processes")).toBeDisabled();
  });
});
