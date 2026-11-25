import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../../test/mfaHarness";

const ipc = vi.hoisted(() => ({
  vaultStatus: vi.fn(), vaultInit: vi.fn(), vaultUnlock: vi.fn(), vaultLock: vi.fn(),
  vaultChangeMaster: vi.fn(), vaultDelete: vi.fn(), vaultList: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ipc);
vi.mock("../../stores/appStore", () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ vaultUnlockMode: "startup", setVaultUnlockMode: vi.fn() }),
}));

import { useVaultStore } from "../../stores/vaultStore";
import { VaultSettings } from "./VaultSettings";

beforeEach(() => {
  Object.values(ipc).forEach((fn) => fn.mockReset());
  ipc.vaultStatus.mockResolvedValue({ state: "unlocked", entry_count: 0 });
  ipc.vaultList.mockResolvedValue([]);
  useVaultStore.setState({ state: "unlocked", entries: [], entryCount: 0, transitionPending: false,
    requiresUnlock: false, securityEpoch: useVaultStore.getState().securityEpoch + 1 });
});
afterEach(cleanup);

it("shows a retryable native lock error while keeping codes gated and enabling verified unlock", async () => {
  const locking = deferred<void>();
  ipc.vaultLock.mockReturnValue(locking.promise);
  render(<VaultSettings />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByTestId("vault-lock-button"));
  expect(useVaultStore.getState()).toMatchObject({ state: "locked", transitionPending: true, requiresUnlock: true });
  expect(screen.getByTestId("vault-unlock-button")).toBeDisabled();
  await act(async () => locking.reject(new Error("host cleanup timed out; retry lock")));
  expect(screen.getByRole("alert")).toHaveTextContent("host cleanup timed out; retry lock");
  expect(screen.getByTestId("vault-unlock-button")).toBeEnabled();
  expect(useVaultStore.getState()).toMatchObject({ state: "locked", transitionPending: false, requiresUnlock: true });
  fireEvent.click(screen.getByTestId("vault-unlock-button"));
  fireEvent.change(screen.getByTestId("vault-unlock-pw"), { target: { value: "verified-password" } });
  await act(async () => fireEvent.click(screen.getByTestId("vault-unlock-confirm")));
  expect(ipc.vaultUnlock).toHaveBeenCalledWith("verified-password");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByTestId("vault-lock-button")).toBeVisible();
  expect(useVaultStore.getState()).toMatchObject({ state: "unlocked", requiresUnlock: false });
});
