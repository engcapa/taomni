import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SockscapLifecycleSnapshot } from "../../lib/sockscap";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
  recover: vi.fn(async () => undefined),
  setRestoreOnSystemLogin: vi.fn(async () => undefined),
  state: {
    loading: false,
    actionPending: null,
    lifecycle: null,
  } as {
    loading: boolean;
    actionPending: string | null;
    lifecycle: SockscapLifecycleSnapshot | null;
  },
}));

vi.mock("../../stores/sockscapStore", () => ({
  useSockscapStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    ...mocks.state,
    refresh: mocks.refresh,
    recover: mocks.recover,
    setRestoreOnSystemLogin: mocks.setRestoreOnSystemLogin,
  }),
}));

import { SockscapLifecycle } from "./SockscapLifecycle";

function lifecycle(overrides: Partial<SockscapLifecycleSnapshot> = {}): SockscapLifecycleSnapshot {
  const capabilities = {
    platform: "linux" as const,
    items: [
      {
        id: "capture_plane",
        name: "Capture plane",
        level: "not_implemented" as const,
        detail: "No signed adapter is packaged.",
        requiredForStart: true,
      },
    ],
    canStartGlobal: false,
    canStartAppGroup: false,
    canAttachPid: false,
    summary: "Capture unavailable",
    captureImplemented: false,
  };
  const status = {
    state: "disabled" as const,
    message: "Disabled",
    activeProfileIds: [],
    lastError: null,
    recoveryRequired: false,
    captureActive: false,
  };
  return {
    capabilities,
    status,
    preferences: { restoreOnSystemLogin: false, updatedAt: null },
    systemLoginRegistered: false,
    systemLoginRegistrationErrorCode: null,
    canEnableAutoRestore: false,
    autoRestoreReady: false,
    autoRestoreStatusCode: "CAPTURE_ADAPTER_NOT_READY",
    lastCommittedConfig: null,
    recovery: {
      generation: 0,
      phase: "clean",
      cleanupRequired: false,
      restoreAfterRecovery: false,
      configRevision: 0,
      platform: "linux",
      activeProfileIds: [],
      artifactStatePresent: false,
      helperPid: null,
      lastHeartbeatAt: null,
      lastErrorCode: null,
      createdAt: 1,
      updatedAt: 1,
    },
    ...overrides,
  };
}

describe("SockscapLifecycle", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.loading = false;
    mocks.state.actionPending = null;
    mocks.state.lifecycle = lifecycle();
  });

  it("keeps login restore disabled behind the native capture gate", () => {
    render(<SockscapLifecycle />);
    expect(screen.getByTestId("sockscap-lifecycle")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Launch Taomni/i })).toBeDisabled();
    expect(screen.getByText("CAPTURE_ADAPTER_NOT_READY")).toBeInTheDocument();
    expect(screen.getByText("Capture plane")).toBeInTheDocument();
    expect(screen.getByText("blocks start")).toBeInTheDocument();
  });

  it("always lets the user turn an existing login registration off", () => {
    mocks.state.lifecycle = lifecycle({
      preferences: { restoreOnSystemLogin: true, updatedAt: 2 },
      systemLoginRegistered: true,
    });
    render(<SockscapLifecycle />);
    const toggle = screen.getByRole("switch", { name: /Launch Taomni/i });
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(mocks.setRestoreOnSystemLogin).toHaveBeenCalledWith(false);
  });

  it("surfaces helper-confirmed recovery as the only cleanup action", () => {
    const status = {
      state: "recovery_required" as const,
      message: "Recovery required",
      activeProfileIds: ["profile-a"],
      lastError: "RECOVERY_REQUIRED",
      recoveryRequired: true,
      captureActive: false,
    };
    mocks.state.lifecycle = lifecycle({
      status,
      recovery: {
        ...lifecycle().recovery,
        generation: 7,
        phase: "recovery_required",
        cleanupRequired: true,
        artifactStatePresent: true,
        lastErrorCode: "RECOVERY_REQUIRED",
      },
    });
    render(<SockscapLifecycle />);
    fireEvent.click(screen.getByTestId("sockscap-lifecycle-recover"));
    expect(mocks.recover).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/must confirm that system network state is clean/i)).toBeInTheDocument();
  });
});
