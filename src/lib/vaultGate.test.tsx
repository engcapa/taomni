import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultGateProvider, ensureVaultReady } from "./vaultGate";

/**
 * The gate drives the real vault dialogs but reads/acts on the vault store.
 * We mock the store so the test can pin the state and observe init/unlock.
 */
const vaultMock = vi.hoisted(() => ({
  state: "empty" as "empty" | "locked" | "unlocked",
  refresh: vi.fn(async () => undefined),
  init: vi.fn(async () => undefined),
  unlock: vi.fn(async () => undefined),
}));

vi.mock("../stores/vaultStore", () => ({
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
  init: vaultMock.init,
  unlock: vaultMock.unlock,
};

beforeEach(() => {
  vaultMock.state = "empty";
  vaultMock.refresh.mockClear();
  vaultMock.init.mockClear();
  vaultMock.unlock.mockClear();
  // refresh() is a no-op that does not change state in these tests.
  vaultMock.refresh.mockImplementation(async () => undefined);
});

afterEach(() => cleanup());

describe("ensureVaultReady", () => {
  it("resolves true immediately without a dialog when the vault is unlocked", async () => {
    vaultMock.state = "unlocked";
    render(<VaultGateProvider>app</VaultGateProvider>);

    await expect(ensureVaultReady()).resolves.toBe(true);
    expect(screen.queryByTestId("vault-setup-dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vault-unlock-dialog")).not.toBeInTheDocument();
  });

  it("pops the setup dialog when the vault is empty and resolves true after init", async () => {
    vaultMock.state = "empty";
    const user = userEvent.setup();
    render(<VaultGateProvider>app</VaultGateProvider>);

    const ready = ensureVaultReady("save this password");
    // Once initialized, the store flips to unlocked.
    vaultMock.init.mockImplementation(async () => {
      vaultMock.state = "unlocked";
    });

    expect(await screen.findByTestId("vault-setup-dialog")).toBeInTheDocument();
    await user.type(screen.getByTestId("vault-setup-pw1"), "masterpass1");
    await user.type(screen.getByTestId("vault-setup-pw2"), "masterpass1");
    await user.click(screen.getByTestId("vault-setup-confirm"));

    await expect(ready).resolves.toBe(true);
    expect(vaultMock.init).toHaveBeenCalledWith("masterpass1");
  });

  it("pops the unlock dialog when the vault is locked and resolves true after unlock", async () => {
    vaultMock.state = "locked";
    const user = userEvent.setup();
    render(<VaultGateProvider>app</VaultGateProvider>);

    const ready = ensureVaultReady("unlock to continue");
    vaultMock.unlock.mockImplementation(async () => {
      vaultMock.state = "unlocked";
    });

    expect(await screen.findByTestId("vault-unlock-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("vault-unlock-reason")).toHaveTextContent("unlock to continue");
    await user.type(screen.getByTestId("vault-unlock-pw"), "the-master");
    await user.click(screen.getByTestId("vault-unlock-confirm"));

    await expect(ready).resolves.toBe(true);
    expect(vaultMock.unlock).toHaveBeenCalledWith("the-master");
  });

  it("resolves false when the user cancels the gate", async () => {
    vaultMock.state = "locked";
    const user = userEvent.setup();
    render(<VaultGateProvider>app</VaultGateProvider>);

    const ready = ensureVaultReady();
    expect(await screen.findByTestId("vault-unlock-dialog")).toBeInTheDocument();
    await user.click(screen.getByTestId("vault-unlock-cancel"));

    await expect(ready).resolves.toBe(false);
    await waitFor(() =>
      expect(screen.queryByTestId("vault-unlock-dialog")).not.toBeInTheDocument(),
    );
  });
});
