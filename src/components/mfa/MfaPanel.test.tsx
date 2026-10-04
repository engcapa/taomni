import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeText = vi.fn(async (_text: string) => undefined);
vi.mock("../../lib/clipboard", () => ({ writeText: (text: string) => writeText(text), readClipboardImageFiles: async () => [] }));
vi.mock("@tauri-apps/api/core", async () => {
  const { stubMfaInvoke } = await import("../../stubs/mfaStub");
  return { invoke: (cmd: string, args?: Record<string, unknown>) => stubMfaInvoke(cmd, args, true) };
});

import { MFA_STUB_STORAGE_KEY } from "../../stubs/mfaStub";
import { useMfaStore } from "../../stores/mfaStore";
import { MfaPanel } from "./MfaPanel";

const RFC4226 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function rows() {
  return screen.queryAllByTestId("mfa-account-row").map((row) => row.getAttribute("data-issuer"));
}

async function addHotp(issuer: string, account = "qa", secret = RFC4226) {
  fireEvent.click(screen.getByTestId(screen.queryByTestId("mfa-empty") ? "mfa-empty-add-secret" : "mfa-add"));
  fireEvent.change(screen.getByTestId("mfa-add-issuer"), { target: { value: issuer } });
  fireEvent.change(screen.getByTestId("mfa-add-account"), { target: { value: account } });
  fireEvent.change(screen.getByTestId("mfa-add-secret"), { target: { value: secret } });
  fireEvent.click(screen.getByTestId("mfa-add-advanced"));
  fireEvent.change(screen.getByTestId("mfa-add-kind"), { target: { value: "hotp" } });
  fireEvent.click(screen.getByTestId("mfa-add-submit"));
  await waitFor(() => expect(screen.queryByTestId("mfa-add-dialog")).toBeNull());
}

describe("MfaPanel", () => {
  afterEach(cleanup);
  beforeEach(() => {
    localStorage.removeItem(MFA_STUB_STORAGE_KEY);
    writeText.mockClear();
    useMfaStore.setState({ status: "idle", accounts: [], codes: {}, query: "", error: null, errorCode: null, lastCopied: null, prefs: { sortMode: "custom", groupFilter: "" } });
  });

  it("adds an HOTP account, copies its code and advances the counter", async () => {
    const onStatus = vi.fn();
    render(<MfaPanel onStatusMessage={onStatus} />);
    expect(await screen.findByTestId("mfa-empty")).toBeInTheDocument();
    await addHotp("QA Bank");
    const code = await screen.findByTestId("mfa-account-code");
    await waitFor(() => expect(code).toHaveTextContent("755 224"));
    expect(code).toHaveAttribute("data-code", "755224");

    fireEvent.click(screen.getByTestId("mfa-account-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("755224"));
    expect(screen.getByTestId("mfa-status")).toHaveTextContent("Copied QA Bank · qa code");
    expect(onStatus).toHaveBeenCalledWith("Copied QA Bank · qa code");

    fireEvent.click(screen.getByTestId("mfa-account-hotp-next"));
    await waitFor(() => expect(screen.getByTestId("mfa-account-code")).toHaveTextContent("287 082"));
    expect(JSON.parse(localStorage.getItem(MFA_STUB_STORAGE_KEY)!).accounts[0].counter).toBe(1);
  });

  it("rejects an invalid secret without saving", async () => {
    render(<MfaPanel />);
    fireEvent.click(await screen.findByTestId("mfa-empty-add-secret"));
    fireEvent.change(screen.getByTestId("mfa-add-issuer"), { target: { value: "Bad" } });
    fireEvent.change(screen.getByTestId("mfa-add-secret"), { target: { value: "not base32!" } });
    fireEvent.click(screen.getByTestId("mfa-add-submit"));
    expect(await screen.findByTestId("mfa-add-error")).toHaveTextContent("Base32");
    expect(screen.getByTestId("mfa-add-secret")).toHaveAttribute("aria-invalid", "true");
    expect(localStorage.getItem(MFA_STUB_STORAGE_KEY)).toBeNull();
  });

  it("searches, copies the first match with Enter, sorts, pins and reorders", async () => {
    render(<MfaPanel />);
    await screen.findByTestId("mfa-empty");
    // The same secret and parameters would be a duplicate, so Zeta uses its own.
    await addHotp("Zeta Cloud", "z", "MFRGGZDFMZTWQ2LK");
    await addHotp("Alpha Mail", "a");
    fireEvent.click(screen.getByTestId("mfa-add"));
    fireEvent.change(screen.getByTestId("mfa-add-uri"), {
      target: { value: "otpauth://totp/Mid%20Bank:m?secret=JBSWY3DPEHPK3PXP&issuer=Mid%20Bank" },
    });
    expect(screen.getByTestId("mfa-add-issuer")).toHaveValue("Mid Bank");
    fireEvent.click(screen.getByTestId("mfa-add-submit"));
    await waitFor(() => expect(rows()).toEqual(["Zeta Cloud", "Alpha Mail", "Mid Bank"]));
    expect(screen.getAllByTestId("mfa-account-countdown")).toHaveLength(1);

    fireEvent.change(screen.getByTestId("mfa-search"), { target: { value: "mail" } });
    expect(rows()).toEqual(["Alpha Mail"]);
    fireEvent.keyDown(screen.getByTestId("mfa-search"), { key: "Enter" });
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("755224"));
    fireEvent.change(screen.getByTestId("mfa-search"), { target: { value: "nothing" } });
    expect(screen.getByTestId("mfa-no-results")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("mfa-search"), { target: { value: "" } });

    fireEvent.change(screen.getByTestId("mfa-sort-mode"), { target: { value: "issuer" } });
    expect(rows()).toEqual(["Alpha Mail", "Mid Bank", "Zeta Cloud"]);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(MFA_STUB_STORAGE_KEY)!).prefs.sortMode).toBe("issuer"));

    const zeta = screen.getAllByTestId("mfa-account-row")[2];
    fireEvent.click(within(zeta).getByTestId("mfa-account-pin"));
    await waitFor(() => expect(rows()).toEqual(["Zeta Cloud", "Alpha Mail", "Mid Bank"]));

    fireEvent.change(screen.getByTestId("mfa-sort-mode"), { target: { value: "custom" } });
    const alpha = screen.getAllByTestId("mfa-account-row")[1];
    fireEvent.click(within(alpha).getByTestId("mfa-account-menu"));
    fireEvent.click(await screen.findByTestId("mfa-menu-move-down"));
    await waitFor(() => expect(rows()).toEqual(["Zeta Cloud", "Mid Bank", "Alpha Mail"]));
    const stored = JSON.parse(localStorage.getItem(MFA_STUB_STORAGE_KEY)!).accounts as Array<{ issuer: string; sortOrder: number }>;
    expect([...stored].sort((a, b) => a.sortOrder - b.sortOrder).map((a) => a.issuer)).toEqual(["Zeta Cloud", "Mid Bank", "Alpha Mail"]);
  });

  it("edits the group used by the filter and deletes after confirmation", async () => {
    render(<MfaPanel />);
    await screen.findByTestId("mfa-empty");
    await addHotp("QA Bank");
    fireEvent.click(screen.getByTestId("mfa-account-menu"));
    fireEvent.click(await screen.findByTestId("mfa-menu-edit"));
    fireEvent.change(screen.getByTestId("mfa-edit-group"), { target: { value: "Work" } });
    fireEvent.click(screen.getByTestId("mfa-edit-save"));
    await waitFor(() => expect(screen.getByTestId("mfa-account-group")).toHaveTextContent("Work"));
    fireEvent.change(screen.getByTestId("mfa-group-filter"), { target: { value: "__ungrouped__" } });
    expect(screen.getByTestId("mfa-no-results")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("mfa-group-filter"), { target: { value: "Work" } });
    expect(rows()).toEqual(["QA Bank"]);

    (window as unknown as { __seeded_confirm?: boolean }).__seeded_confirm = false;
    fireEvent.click(screen.getByTestId("mfa-account-menu"));
    fireEvent.click(await screen.findByTestId("mfa-menu-delete"));
    await act(async () => undefined);
    expect(rows()).toEqual(["QA Bank"]);
    (window as unknown as { __seeded_confirm?: boolean }).__seeded_confirm = true;
    fireEvent.click(screen.getByTestId("mfa-account-menu"));
    fireEvent.click(await screen.findByTestId("mfa-menu-delete"));
    await waitFor(() => expect(screen.getByTestId("mfa-empty")).toBeInTheDocument());
    delete (window as unknown as { __seeded_confirm?: boolean }).__seeded_confirm;
  });

  it("opens the QR export dialog from the row menu", async () => {
    render(<MfaPanel />);
    await screen.findByTestId("mfa-empty");
    await addHotp("QA Bank");
    fireEvent.click(screen.getByTestId("mfa-account-menu"));
    fireEvent.click(await screen.findByTestId("mfa-menu-qr"));
    expect(await screen.findByTestId("mfa-qr-dialog")).toHaveAttribute("data-state", "locked");
    fireEvent.change(screen.getByTestId("mfa-qr-password"), { target: { value: "any" } });
    fireEvent.click(screen.getByTestId("mfa-qr-reveal"));
    expect(await screen.findByTestId("mfa-qr-image")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mfa-qr-close"));
    expect(screen.queryByTestId("mfa-qr-dialog")).toBeNull();
  });

  it("opens the secret copy dialog from the row menu and copies secret on reveal", async () => {
    const onStatus = vi.fn();
    render(<MfaPanel onStatusMessage={onStatus} />);
    await screen.findByTestId("mfa-empty");
    await addHotp("QA Bank");
    fireEvent.click(screen.getByTestId("mfa-account-menu"));
    fireEvent.click(await screen.findByTestId("mfa-menu-copy-secret"));
    expect(await screen.findByTestId("mfa-qr-dialog")).toHaveAttribute("data-state", "locked");
    fireEvent.change(screen.getByTestId("mfa-qr-password"), { target: { value: "any" } });
    fireEvent.click(screen.getByTestId("mfa-qr-reveal"));
    expect(await screen.findByTestId("mfa-qr-secret")).toBeInTheDocument();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RFC4226));
    expect(screen.getByTestId("mfa-status")).toHaveTextContent("Copied QA Bank · qa secret key");
    fireEvent.click(screen.getByTestId("mfa-qr-close"));
    expect(screen.queryByTestId("mfa-qr-dialog")).toBeNull();
  });
});
