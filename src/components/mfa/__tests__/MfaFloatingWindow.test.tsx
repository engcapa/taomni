import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaFloatingWindow } from "../MfaFloatingWindow";
import { useAppStore } from "../../../stores/appStore";
import { useMfaStore } from "../../../stores/mfaStore";
import { useVaultStore } from "../../../stores/vaultStore";
import type { MfaAccount } from "../../../lib/mfa/types";

const account = (id: string, issuer: string): MfaAccount => ({
  id,
  issuer,
  accountName: `${issuer.toLowerCase()}@example.com`,
  group: "",
  note: "",
  kind: "totp",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  counter: 0,
  pinned: false,
  sortOrder: 1,
  useCount: 0,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 1,
});

const accounts = [account("mfa-1", "GitHub"), account("mfa-2", "AWS Console")];

const copyCode = vi.fn(async () => "123456");
const load = vi.fn(async () => undefined);
const refreshCodes = vi.fn(async () => undefined);

function openWindow(): void {
  useAppStore.setState({
    floatingMfa: { open: true, pinned: false, position: { left: 50, bottom: 30 }, searchQuery: "" },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useVaultStore.setState({ state: "unlocked", entryCount: 2, loading: false, entries: [] });
  useVaultStore.setState({ refresh: vi.fn(async () => undefined) as never });
  useMfaStore.setState({
    status: "ready",
    error: null,
    errorCode: null,
    accounts,
    codes: {
      "mfa-1": { id: "mfa-1", code: "123456", nextCode: null, period: 30, counter: 0, validFromMs: null, validUntilMs: null },
      "mfa-2": { id: "mfa-2", code: "654321", nextCode: null, period: 30, counter: 0, validFromMs: null, validUntilMs: null },
    },
    lastCopied: null,
    copyCode,
    load,
    refreshCodes,
  });
  copyCode.mockClear();
  useAppStore.setState({
    floatingMfa: { open: false, pinned: false, position: { left: 50, bottom: 30 }, searchQuery: "" },
    statusMessage: "",
  });
});

afterEach(() => {
  cleanup();
});

describe("MfaFloatingWindow (TASK-04)", () => {
  it("UT-WS-04-01 mounts at the bottom-left default position", () => {
    openWindow();
    render(<MfaFloatingWindow onExpand={vi.fn()} />);
    const window = screen.getByTestId("mfa-floating-window");
    expect(window).toBeVisible();
    expect(window.style.left).toBe("50px");
    expect(window.style.bottom).toBe("30px");
    expect(window.style.position).toBe("fixed");
  });

  it("UT-WS-04-02 gates the token list behind the vault", () => {
    useVaultStore.setState({ state: "locked" });
    openWindow();
    render(<MfaFloatingWindow onExpand={vi.fn()} />);
    expect(screen.getByTestId("mfa-floating-locked")).toBeInTheDocument();
    expect(screen.queryByTestId("mfa-floating-account")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mfa-floating-search")).not.toBeInTheDocument();

    act(() => useVaultStore.setState({ state: "unlocked" }));
    expect(screen.getAllByTestId("mfa-floating-account")).toHaveLength(2);
    expect(screen.getByTestId("mfa-floating-search")).toBeInTheDocument();
  });

  it("UT-WS-04-03 filters accounts and copies the current code on click", async () => {
    openWindow();
    render(<MfaFloatingWindow onExpand={vi.fn()} />);
    fireEvent.change(screen.getByTestId("mfa-floating-search"), { target: { value: "github" } });
    const visible = screen.getAllByTestId("mfa-floating-account");
    expect(visible).toHaveLength(1);
    expect(visible[0].textContent).toContain("GitHub");

    await act(async () => {
      fireEvent.click(visible[0]);
    });
    expect(copyCode).toHaveBeenCalledWith("mfa-1");
    expect(useAppStore.getState().statusMessage.toLowerCase()).toContain("copied");
  });

  it("UT-WS-04-04 drags the window within the viewport bounds", () => {
    openWindow();
    render(<MfaFloatingWindow onExpand={vi.fn()} />);
    const handle = screen.getByTestId("mfa-floating-drag-handle");
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 220, clientY: 40 });
    expect(useAppStore.getState().floatingMfa.position.left).toBeGreaterThan(50);
    expect(useAppStore.getState().floatingMfa.position.bottom).toBeGreaterThan(30);

    fireEvent.pointerMove(window, { clientX: 99999, clientY: -99999 });
    const position = useAppStore.getState().floatingMfa.position;
    expect(position.left).toBeLessThanOrEqual(window.innerWidth - 310);
    expect(position.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(position.bottom).toBeGreaterThan(0);
    fireEvent.pointerUp(window);
  });

  it("UT-WS-04-05 expands into the full MFA tab and closes the floating window", () => {
    const onExpand = vi.fn(() => {
      useAppStore.setState({ activeSideTab: "sessions" });
    });
    openWindow();
    render(<MfaFloatingWindow onExpand={onExpand} />);
    fireEvent.click(screen.getByTestId("mfa-floating-expand-tab"));
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().floatingMfa.open).toBe(false);
    expect(useAppStore.getState().activeSideTab).toBe("sessions");
  });
});
