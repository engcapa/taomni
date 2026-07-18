import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setSection: vi.fn(),
  initialize: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  recover: vi.fn(async () => undefined),
  dismissError: vi.fn(),
  bridgeCleanup: vi.fn(),
  closeWindow: vi.fn(async () => "closed"),
  state: {
    section: "overview",
    initialized: true,
    loading: false,
    actionPending: null,
    error: null,
    capabilities: {
      platform: "linux",
      items: [{ id: "capture", name: "Capture", level: "supported", detail: "Ready", requiredForStart: true }],
      canStartGlobal: true,
      canStartAppGroup: true,
      canAttachPid: true,
      summary: "Linux ready",
      captureImplemented: true,
    },
    status: {
      state: "disabled",
      message: "Disabled",
      activeProfileIds: [],
      lastError: null,
      recoveryRequired: false,
      captureActive: false,
    },
    profiles: [],
    egressSessions: [],
    ruleSources: [],
    stats: null,
    alerts: [],
  } as Record<string, unknown>,
}));

vi.mock("../../stores/sockscapStore", () => ({
  useSockscapStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    ...mocks.state,
    setSection: mocks.setSection,
    initialize: mocks.initialize,
    refresh: mocks.refresh,
    start: mocks.start,
    stop: mocks.stop,
    recover: mocks.recover,
    dismissError: mocks.dismissError,
  }),
  attachSockscapEventBridge: () => mocks.bridgeCleanup,
}));

vi.mock("../../lib/sockscap", () => ({
  sockscapCloseWindow: mocks.closeWindow,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: vi.fn(async () => undefined),
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    onCloseRequested: vi.fn(async () => vi.fn()),
  }),
}));

import { SockscapWindow } from "./SockscapWindow";

describe("SockscapWindow shell", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.section = "overview";
    mocks.state.error = null;
    mocks.state.status = {
      state: "disabled",
      message: "Disabled",
      activeProfileIds: [],
      lastError: null,
      recoveryRequired: false,
      captureActive: false,
    };
  });

  it("renders the independent navigation, capability summary, and start action", () => {
    render(<SockscapWindow />);
    expect(screen.getByTestId("sockscap-window")).toBeInTheDocument();
    expect(screen.getByTestId("sockscap-status")).toHaveTextContent("disabled");
    expect(screen.getByText("Linux ready")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sockscap-start"));
    expect(mocks.start).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("sockscap-nav-profiles"));
    expect(mocks.setSection).toHaveBeenCalledWith("profiles");
  });

  it("shows recovery as a blocking first-class action", () => {
    mocks.state.status = {
      state: "recovery_required",
      message: "Recovery required",
      activeProfileIds: [],
      lastError: "RECOVERY_REQUIRED",
      recoveryRequired: true,
      captureActive: false,
    };
    render(<SockscapWindow />);
    expect(screen.getByTestId("sockscap-start")).toBeDisabled();
    fireEvent.click(screen.getByTestId("sockscap-recover"));
    expect(mocks.recover).toHaveBeenCalledTimes(1);
  });

  it("detaches the event bridge when the window unmounts", () => {
    const view = render(<SockscapWindow />);
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mocks.bridgeCleanup).toHaveBeenCalledTimes(1);
  });
});
