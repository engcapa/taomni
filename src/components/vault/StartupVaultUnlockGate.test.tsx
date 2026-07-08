import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupVaultUnlockGate } from "./StartupVaultUnlockGate";

const appMock = vi.hoisted(() => ({
  vaultUnlockMode: "startup" as "startup" | "on-demand",
}));

const vaultMock = vi.hoisted(() => ({
  state: "empty" as "empty" | "locked" | "unlocked",
  refresh: vi.fn(async () => undefined),
  unlock: vi.fn(async () => undefined),
}));

vi.mock("../../stores/appStore", () => ({
  useAppStore: (selector: (s: typeof appMock) => unknown) => selector(appMock),
}));

vi.mock("../../stores/vaultStore", () => ({
  useVaultStore: Object.assign(
    (selector: (s: typeof selectorState) => unknown) => selector(selectorState),
    { getState: () => ({ state: vaultMock.state }) },
  ),
}));

const selectorState = {
  get state() {
    return vaultMock.state;
  },
  refresh: vaultMock.refresh,
  unlock: vaultMock.unlock,
};

beforeEach(() => {
  appMock.vaultUnlockMode = "startup";
  vaultMock.state = "empty";
  vaultMock.refresh.mockReset();
  vaultMock.refresh.mockResolvedValue(undefined);
  vaultMock.unlock.mockReset();
  vaultMock.unlock.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("StartupVaultUnlockGate", () => {
  it("prompts once on startup when the vault is locked and startup mode is enabled", async () => {
    appMock.vaultUnlockMode = "startup";
    vaultMock.state = "locked";
    const user = userEvent.setup();

    render(<StartupVaultUnlockGate>app</StartupVaultUnlockGate>);

    expect(await screen.findByTestId("vault-unlock-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("vault-unlock-reason")).toHaveTextContent(
      /saved passwords available/i,
    );

    await user.type(screen.getByTestId("vault-unlock-pw"), "masterpass");
    await user.click(screen.getByTestId("vault-unlock-confirm"));

    expect(vaultMock.unlock).toHaveBeenCalledWith("masterpass");
    await waitFor(() =>
      expect(screen.queryByTestId("vault-unlock-dialog")).not.toBeInTheDocument(),
    );
  });

  it("does not prompt on startup when on-demand mode is selected", async () => {
    appMock.vaultUnlockMode = "on-demand";
    vaultMock.state = "locked";

    render(<StartupVaultUnlockGate>app</StartupVaultUnlockGate>);

    expect(vaultMock.refresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId("vault-unlock-dialog")).not.toBeInTheDocument();
  });

  it("does not force first-time setup when the vault is empty", async () => {
    appMock.vaultUnlockMode = "startup";
    vaultMock.state = "empty";

    render(<StartupVaultUnlockGate>app</StartupVaultUnlockGate>);

    await waitFor(() => expect(vaultMock.refresh).toHaveBeenCalled());
    expect(screen.queryByTestId("vault-unlock-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vault-setup-dialog")).not.toBeInTheDocument();
  });
});
