import { StrictMode } from "react";
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
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.queryByTestId("vault-unlock-cancel")).not.toBeInTheDocument();
    expect(screen.getByTestId("vault-unlock-reason")).toHaveTextContent(
      /saved passwords available/i,
    );

    await user.type(screen.getByTestId("vault-unlock-pw"), "masterpass");
    await user.click(screen.getByTestId("vault-unlock-confirm"));

    expect(vaultMock.unlock).toHaveBeenCalledWith("masterpass");
    await waitFor(() =>
      expect(screen.queryByTestId("vault-unlock-dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("app")).toBeInTheDocument();
  });

  it("does not prompt on startup when on-demand mode is selected", async () => {
    appMock.vaultUnlockMode = "on-demand";
    vaultMock.state = "locked";

    render(<StartupVaultUnlockGate>app</StartupVaultUnlockGate>);

    expect(vaultMock.refresh).not.toHaveBeenCalled();
    expect(screen.queryByTestId("vault-unlock-dialog")).not.toBeInTheDocument();
    expect(screen.getByText("app")).toBeInTheDocument();
  });

  it("does not force first-time setup when the vault is empty", async () => {
    appMock.vaultUnlockMode = "startup";
    vaultMock.state = "empty";

    render(<StartupVaultUnlockGate>app</StartupVaultUnlockGate>);

    await waitFor(() => expect(vaultMock.refresh).toHaveBeenCalled());
    expect(screen.queryByTestId("vault-unlock-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vault-setup-dialog")).not.toBeInTheDocument();
    expect(screen.getByText("app")).toBeInTheDocument();
  });

  it("blocks the app while startup vault status is being checked", async () => {
    appMock.vaultUnlockMode = "startup";
    vaultMock.state = "unlocked";
    let resolveRefresh: (() => void) | undefined;
    vaultMock.refresh.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveRefresh = () => resolve(undefined);
        }),
    );

    render(<StartupVaultUnlockGate>app</StartupVaultUnlockGate>);

    expect(screen.getByTestId("startup-vault-check")).toBeInTheDocument();
    expect(screen.getByText("app")).toBeInTheDocument();

    resolveRefresh?.();
    await waitFor(() => expect(screen.getByText("app")).toBeInTheDocument());
    expect(screen.queryByTestId("startup-vault-check")).not.toBeInTheDocument();
  });

  it("does not get stuck on the loading screen under React StrictMode", async () => {
    appMock.vaultUnlockMode = "startup";
    vaultMock.state = "empty";
    const resolveRefreshes: Array<() => void> = [];
    vaultMock.refresh.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveRefreshes.push(() => resolve(undefined));
        }),
    );

    render(
      <StrictMode>
        <StartupVaultUnlockGate>app</StartupVaultUnlockGate>
      </StrictMode>,
    );

    expect(screen.getByTestId("startup-vault-check")).toBeInTheDocument();
    expect(screen.getByText("app")).toBeInTheDocument();
    await waitFor(() => expect(resolveRefreshes.length).toBeGreaterThanOrEqual(2));
    resolveRefreshes.forEach((resolve) => resolve());

    await waitFor(() => expect(screen.getByText("app")).toBeInTheDocument());
    expect(screen.queryByTestId("startup-vault-check")).not.toBeInTheDocument();
  });
});
