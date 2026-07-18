import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshDashboard: vi.fn(async () => undefined),
  clearStats: vi.fn(async () => ({ removedRows: 4, removedLiveSamples: 2 })),
  dismissAlert: vi.fn(),
  setSection: vi.fn(),
  state: {} as Record<string, unknown>,
}));

vi.mock("../../stores/sockscapStore", () => ({
  useSockscapStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    ...mocks.state,
    refreshDashboard: mocks.refreshDashboard,
    clearStats: mocks.clearStats,
    dismissAlert: mocks.dismissAlert,
    setSection: mocks.setSection,
  }),
}));

import { SockscapDashboard } from "./SockscapDashboard";

describe("SockscapDashboard", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state = {
      profiles: [{
        profile: {
          id: "profile-1",
          name: "Browser profile",
          enabled: true,
          statsPrivacy: {
            collectionMode: "persisted",
            domainAggregationEnabled: true,
          },
        },
      }],
      stats: {
        generatedAt: 1_700_000_100,
        fromUnix: 1_700_000_000,
        toUnix: 1_700_000_100,
        totals: {
          bytesUp: 512,
          bytesDown: 1024,
          connections: 10,
          errors: 1,
          directConnections: 3,
          proxyConnections: 5,
          blockedConnections: 2,
          unknownHostnameConnections: 4,
          connectMillisTotal: 250,
        },
        series: [{
          bucketStart: 1_700_000_000,
          resolutionSeconds: 60,
          bytesUp: 512,
          bytesDown: 1024,
          connections: 10,
          errors: 1,
          directConnections: 3,
          proxyConnections: 5,
          blockedConnections: 2,
        }],
        topApplications: [{ key: "Browser", bytesUp: 512, bytesDown: 1024, connections: 10 }],
        topDomains: [{ key: "example.test", bytesUp: 256, bytesDown: 512, connections: 5 }],
        egressHealth: [{
          bucketStart: 1_700_000_000,
          profileId: "profile-1",
          egressKind: "ssh_jump",
          controlState: "healthy",
          activeControlsMax: 1,
          activeChannelsMax: 4,
          channelErrors: 0,
          reconnects: 0,
          bytesUp: 512,
          bytesDown: 1024,
          handshakeMillisTotal: 40,
          handshakeSamples: 1,
          hostKeyState: "verified",
          lastErrorCode: null,
        }],
      },
      liveConnections: {
        generatedAtUnix: 1_700_000_100,
        capacity: 256,
        droppedSamples: 3,
        samples: [{
          sampleId: 8,
          observedAtUnix: 1_700_000_090,
          profileId: "profile-1",
          protocol: "tcp",
          hostnameSource: "tls_sni",
          policyAction: "proxy",
          effectiveAction: "proxy",
          outcome: "established",
          connector: "ssh_jump",
          errorCode: null,
          connectMillis: 40,
        }],
      },
      alerts: [{
        code: "SSH_RECONNECTING",
        message: "SSH control connection is reconnecting",
        severity: "warning",
        createdAtUnix: 1_700_000_080,
      }],
      status: { captureActive: false },
      dashboardLoading: false,
      dashboardActionPending: null,
      dashboardError: null,
    };
  });

  it("renders bounded aggregates, health, alerts, and recent outcomes", async () => {
    render(<SockscapDashboard />);
    expect(screen.getByTestId("sockscap-dashboard")).toBeInTheDocument();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
    expect(screen.getByText("Browser")).toBeInTheDocument();
    expect(screen.getAllByText("Browser profile")).toHaveLength(2);
    expect(screen.getByText("SSH_RECONNECTING")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Upload and download byte totals/i })).toBeInTheDocument();
    expect(screen.getByText(/1\/256 shown · 3 evicted/)).toBeInTheDocument();
    await waitFor(() => expect(mocks.refreshDashboard).toHaveBeenCalledWith(24 * 60 * 60, false));
  });

  it("queries domain rows only after an opted-in user enables them", async () => {
    render(<SockscapDashboard />);
    const toggle = screen.getByTestId("sockscap-domain-aggregation-toggle");
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.refreshDashboard).toHaveBeenCalledWith(24 * 60 * 60, true));
    expect(screen.getByText("example.test")).toBeInTheDocument();
  });

  it("requires confirmation before clearing both aggregate and recent statistics", async () => {
    render(<SockscapDashboard />);
    fireEvent.click(screen.getByTestId("sockscap-clear-stats"));
    expect(await screen.findByRole("dialog", { name: "Clear all Sockscap statistics?" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(mocks.clearStats).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Cleared 4 aggregate row(s) and 2 recent sample(s).")).toBeInTheDocument();
  });

  it("routes privacy changes back to profile settings", () => {
    render(<SockscapDashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Edit profile privacy" }));
    expect(mocks.setSection).toHaveBeenCalledWith("profiles");
  });
});
