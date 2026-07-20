import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  listEgressSessions: vi.fn(),
  listProcesses: vi.fn(),
  upsertProfile: vi.fn(),
  deleteProfile: vi.fn(),
  listProfiles: vi.fn(),
  listRuleSources: vi.fn(),
}));

vi.mock("../../lib/sockscap", async () => {
  const actual = await vi.importActual<typeof import("../../lib/sockscap")>("../../lib/sockscap");
  return {
    ...actual,
    sockscap: ipc,
  };
});

import { appSelectorFromPath, SockscapProfiles } from "./SockscapProfiles";
import { useSockscapStore } from "../../stores/sockscapStore";

beforeEach(() => {
  vi.clearAllMocks();
  useSockscapStore.setState({
    status: null,
    capabilities: null,
    profiles: [],
    ruleSources: [{ id: "gfwlist-official", name: "GFWList", kind: "gfwlist-official", urls: [], enabled: true, minRefreshSecs: 21600 }],
    stats: null,
    loading: false,
    busy: false,
    error: null,
  });
  ipc.listEgressSessions.mockResolvedValue([
    { id: "proxy-1", name: "Office SOCKS", kind: "proxy" },
  ]);
  ipc.listProcesses.mockResolvedValue([
    {
      pid: 4242,
      name: "chrome.exe",
      path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      processStartTime: "t0",
    },
  ]);
  ipc.listProfiles.mockResolvedValue([]);
  ipc.listRuleSources.mockResolvedValue([]);
  ipc.upsertProfile.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("appSelectorFromPath", () => {
  it("builds a windows-executable selector by default", () => {
    const sel = appSelectorFromPath("C:/Apps/foo.exe");
    expect(sel).toEqual({ kind: "windows-executable", value: "C:/Apps/foo.exe" });
  });
});

describe("SockscapProfiles", () => {
  it("shows application selector UI when scope is Applications", async () => {
    render(<SockscapProfiles />);
    fireEvent.click(screen.getByText("+ New profile"));
    const scope = screen.getByDisplayValue("Global");
    fireEvent.change(scope, { target: { value: "applications" } });
    expect(await screen.findByText(/Add at least one application/i)).toBeInTheDocument();
    expect(screen.getByText(/Include child processes/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Applications" })).toBeInTheDocument();
  });

  it("adds a typed application path to the draft list", async () => {
    render(<SockscapProfiles />);
    fireEvent.click(screen.getByText("+ New profile"));
    fireEvent.change(screen.getByDisplayValue("Global"), { target: { value: "applications" } });
    const pathInput = await screen.findByPlaceholderText(/Program Files|\/usr\/bin/i);
    fireEvent.change(pathInput, { target: { value: "C:\\Tools\\curl.exe" } });
    fireEvent.click(screen.getByText("+ Add"));
    expect(screen.getByText(/C:\\Tools\\curl.exe/i)).toBeInTheDocument();
  });

  it("loads processes from the picker", async () => {
    render(<SockscapProfiles />);
    fireEvent.click(screen.getByText("+ New profile"));
    fireEvent.change(screen.getByDisplayValue("Global"), {
      target: { value: "runtime-processes" },
    });
    fireEvent.click(await screen.findByText(/Select running processes/i));
    await waitFor(() => expect(ipc.listProcesses).toHaveBeenCalled());
    expect(await screen.findByText("chrome.exe")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Add PID"));
    expect(screen.getByText(/pid 4242/i)).toBeInTheDocument();
  });
});
