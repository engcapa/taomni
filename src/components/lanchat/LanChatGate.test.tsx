import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared mutable mock state for the two zustand stores the gate reads.
const vault = vi.hoisted(() => ({
  state: "unlocked" as "unlocked" | "locked" | "empty",
  refresh: vi.fn(async () => undefined),
  unlock: vi.fn(async () => undefined),
  init: vi.fn(async () => undefined),
}));
const lan = vi.hoisted(() => ({
  isDesktop: true,
  serviceRunning: false,
  startOnLaunch: false,
  enableService: vi.fn(async () => undefined),
  loadServiceState: vi.fn(async () => undefined),
}));

vi.mock("../../stores/vaultStore", () => ({
  useVaultStore: (sel: (s: typeof vault) => unknown) => sel(vault),
}));
vi.mock("../../stores/lanChatStore", () => ({
  useLanChatStore: (sel: (s: typeof lan) => unknown) => sel(lan),
}));
vi.mock("./LanChatPanel", () => ({
  LanChatPanel: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="lan-panel" data-readonly={readOnly ? "1" : "0"} />
  ),
}));

import { LanChatGate } from "./LanChatGate";

afterEach(() => cleanup());
beforeEach(() => {
  vault.state = "unlocked";
  lan.isDesktop = true;
  lan.serviceRunning = false;
  lan.startOnLaunch = false;
  lan.enableService.mockClear();
  lan.loadServiceState.mockClear();
});

describe("LanChatGate", () => {
  it("renders the full panel when unlocked and the service is running", () => {
    vault.state = "unlocked";
    lan.serviceRunning = true;
    render(<LanChatGate />);
    expect(screen.getByTestId("lan-panel")).toHaveAttribute("data-readonly", "0");
    expect(screen.queryByTestId("lanchat-enable-prompt")).toBeNull();
  });

  it("shows the enable prompt over a read-only panel when unlocked but not running", () => {
    vault.state = "unlocked";
    lan.serviceRunning = false;
    render(<LanChatGate />);
    expect(screen.getByTestId("lanchat-enable-prompt")).toBeInTheDocument();
    expect(screen.getByTestId("lan-panel")).toHaveAttribute("data-readonly", "1");
  });

  it("auto-starts after unlock when start on launch was configured", async () => {
    vault.state = "unlocked";
    lan.serviceRunning = false;
    lan.startOnLaunch = true;
    render(<LanChatGate />);

    await waitFor(() => expect(lan.enableService).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("lanchat-enable-prompt")).toBeNull();
    expect(screen.getByTestId("lan-panel")).toHaveAttribute("data-readonly", "1");
  });

  it("blocks behind the unlock dialog when the vault is locked", () => {
    vault.state = "locked";
    render(<LanChatGate />);
    expect(screen.getByTestId("vault-unlock-pw")).toBeInTheDocument();
    expect(screen.queryByTestId("lan-panel")).toBeNull();
  });

  it("sends a never-initialized vault through setup first", () => {
    vault.state = "empty";
    render(<LanChatGate />);
    // The setup dialog asks for a new password (two fields); no panel yet.
    expect(screen.queryByTestId("lan-panel")).toBeNull();
    expect(screen.queryByTestId("lanchat-enable-prompt")).toBeNull();
  });
});
