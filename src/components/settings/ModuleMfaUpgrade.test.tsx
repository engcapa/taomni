import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { ModuleMfaUpgrade } from "./ModuleMfaUpgrade";

const ipc = vi.hoisted(() => ({
  getMfaMigrationResult: vi.fn(),
  migrateMfaAndRestart: vi.fn(),
}));

vi.mock("../../lib/ipc/plugin", () => ipc);

beforeEach(() => {
  vi.resetAllMocks();
  setLocale("en");
  ipc.getMfaMigrationResult.mockResolvedValue(null);
});

afterEach(cleanup);

it("clears a refused password and submits the retry once while restart is pending", async () => {
  ipc.migrateMfaAndRestart.mockRejectedValueOnce("VAULT_BAD_PASSWORD");
  ipc.migrateMfaAndRestart.mockResolvedValueOnce(undefined);
  render(<ModuleMfaUpgrade eligible />);
  fireEvent.click(screen.getByTestId("module-upgrade-mfa-open"));
  const submit = screen.getByTestId("module-upgrade-mfa-submit");
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByTestId("module-upgrade-mfa-archive"), { target: { value: "/modules/mfa.taomni-plugin" } });
  fireEvent.change(screen.getByTestId("module-upgrade-mfa-signature"), { target: { value: "/modules/mfa.minisig" } });
  const password = screen.getByTestId("module-upgrade-mfa-password");
  fireEvent.input(password, { target: { value: "wrong" } });
  fireEvent.click(submit);
  expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect Vault password");
  expect(password).toHaveValue("");
  expect(submit).toBeDisabled();
  fireEvent.input(password, { target: { value: " original password " } });
  const form = screen.getByTestId("module-upgrade-mfa-form");
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(ipc.migrateMfaAndRestart).toHaveBeenCalledTimes(2);
  expect(ipc.migrateMfaAndRestart).toHaveBeenLastCalledWith("/modules/mfa.taomni-plugin", "/modules/mfa.minisig", " original password ");
  expect(password).toHaveValue("");
  expect(submit).toBeDisabled();
});

it("reports success after the last pending MFA candidate disappears", async () => {
  ipc.getMfaMigrationResult.mockResolvedValue("complete");
  render(<ModuleMfaUpgrade eligible={false} />);
  expect(await screen.findByRole("status")).toHaveTextContent("MFA migration completed.");
  expect(screen.queryByTestId("module-upgrade-mfa-open")).toBeNull();
});

it("uses the installed signed module after requesting the original Vault password", () => {
  ipc.migrateMfaAndRestart.mockResolvedValue(undefined);
  render(<ModuleMfaUpgrade eligible installed />);
  fireEvent.click(screen.getByTestId("module-upgrade-mfa-open"));
  expect(screen.queryByTestId("module-upgrade-mfa-archive")).toBeNull();
  expect(screen.queryByTestId("module-upgrade-mfa-signature")).toBeNull();
  const submit = screen.getByTestId("module-upgrade-mfa-submit");
  expect(submit).toBeDisabled();
  fireEvent.input(screen.getByTestId("module-upgrade-mfa-password"), { target: { value: "original password" } });
  expect(submit).toBeEnabled();
  fireEvent.submit(screen.getByTestId("module-upgrade-mfa-form"));
  expect(ipc.migrateMfaAndRestart).toHaveBeenCalledWith(undefined, undefined, "original password");
});
