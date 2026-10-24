import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MfaFloatingWindow } from "../MfaFloatingWindow";
import { useAppStore, DEFAULT_FLOATING_MFA_POSITION } from "../../../stores/appStore";
import { useMfaStore } from "../../../stores/mfaStore";
import { useVaultStore } from "../../../stores/vaultStore";

function openFloatingMfa() {
  useAppStore.getState().setFloatingMfaOpen(true);
}

function seedAccounts() {
  useMfaStore.setState({
    status: "ready",
    accounts: [
      { id: "acc-1", issuer: "GitHub", accountName: "zhyhang", group: "", note: "", kind: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: 0, pinned: false, sortOrder: 0, useCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0 },
      { id: "acc-2", issuer: "AWS Console", accountName: "ops@taomni", group: "", note: "", kind: "totp", algorithm: "SHA1", digits: 6, period: 30, counter: 0, pinned: false, sortOrder: 1, useCount: 0, lastUsedAt: null, createdAt: 0, updatedAt: 0 },
    ],
    codes: {
      "acc-1": { id: "acc-1", code: "123456", nextCode: "654321", period: 30, counter: 0, validFromMs: Date.now() - 1000, validUntilMs: Date.now() + 15_000 },
      "acc-2": { id: "acc-2", code: "654321", nextCode: null, period: 30, counter: 0, validFromMs: Date.now() - 1000, validUntilMs: Date.now() + 15_000 },
    },
  });
}

describe("MfaFloatingWindow (TASK-04)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({
      floatingMfa: { open: false, pinned: false, position: { ...DEFAULT_FLOATING_MFA_POSITION }, searchQuery: "" },
    });
    useVaultStore.setState({ state: "unlocked", refresh: vi.fn(async () => undefined), unlock: vi.fn(async () => undefined), init: vi.fn(async () => undefined) });
    useMfaStore.setState({
      status: "ready",
      accounts: [],
      codes: {},
      error: null,
      errorCode: null,
      load: vi.fn(async () => undefined),
      refreshCodes: vi.fn(async () => undefined),
      copyCode: vi.fn(async () => "123456"),
      setQuery: vi.fn(),
    });
  });

  afterEach(() => cleanup());

  it("UT-WS-04-01: mounts at the bottom-left default position", () => {
    openFloatingMfa();
    render(<MfaFloatingWindow onExpandTab={vi.fn()} />);
    const floating = screen.getByTestId("mfa-floating-window");
    expect(floating.style.left).toBe("50px");
    expect(floating.style.bottom).toBe("30px");
  });

  it("UT-WS-04-02: gates tokens behind the vault and lists them once unlocked", () => {
    useVaultStore.setState({ state: "locked" });
    openFloatingMfa();
    render(<MfaFloatingWindow onExpandTab={vi.fn()} />);
    expect(screen.queryByTestId("mfa-floating-account")).not.toBeInTheDocument();

    act(() => useVaultStore.setState({ state: "unlocked" }));
    act(() => seedAccounts());
    expect(screen.getAllByTestId("mfa-floating-account")).toHaveLength(2);
  });

  it("UT-WS-04-03: filters by search and copies a code on card click", async () => {
    openFloatingMfa();
    seedAccounts();
    render(<MfaFloatingWindow onExpandTab={vi.fn()} />);
    expect(screen.getAllByTestId("mfa-floating-account")).toHaveLength(2);
    const cards = screen.getAllByTestId("mfa-floating-account");
    expect(cards).toHaveLength(2);

    fireEvent.change(screen.getByTestId("mfa-floating-search"), { target: { value: "github" } });
    expect(useAppStore.getState().floatingMfa.searchQuery).toBe("github");

    // The store's copyCode writes the clipboard; the card confirms the copy.
    fireEvent.click(screen.getAllByTestId("mfa-floating-account")[0]);
    await waitFor(() => {
      expect(useMfaStore.getState().copyCode).toHaveBeenCalledWith("acc-1", "current");
    });
  });

  it("UT-WS-04-04: drags via the handle and clamps to the viewport", () => {
    window.innerWidth = 800;
    window.innerHeight = 600;
    openFloatingMfa();
    render(<MfaFloatingWindow onExpandTab={vi.fn()} />);
    const handle = screen.getByTestId("mfa-floating-drag-handle");

    fireEvent.mouseDown(handle, { button: 0, clientX: 100, clientY: 500 });
    fireEvent.mouseMove(window, { clientX: 220, clientY: 380 });
    fireEvent.mouseUp(window);
    expect(useAppStore.getState().floatingMfa.position).toEqual({ left: 170, bottom: 150 });

    // Dragging far beyond the viewport clamps inside it.
    fireEvent.mouseDown(handle, { button: 0, clientX: 220, clientY: 380 });
    fireEvent.mouseMove(window, { clientX: 5000, clientY: -2000 });
    fireEvent.mouseUp(window);
    const clamped = useAppStore.getState().floatingMfa.position;
    expect(clamped.left).toBeLessThanOrEqual(window.innerWidth);
    expect(clamped.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(clamped.left).toBeGreaterThanOrEqual(0);
    expect(clamped.bottom).toBeGreaterThanOrEqual(0);
  });

  it("UT-WS-04-05: expand opens the full MFA tab and closes the float", () => {
    const onExpandTab = vi.fn();
    openFloatingMfa();
    render(<MfaFloatingWindow onExpandTab={onExpandTab} />);
    fireEvent.click(screen.getByTestId("mfa-floating-expand-tab"));
    expect(onExpandTab).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().floatingMfa.open).toBe(false);
  });

  it("pin toggling and close button update the floating state", () => {
    openFloatingMfa();
    render(<MfaFloatingWindow onExpandTab={vi.fn()} />);
    fireEvent.click(screen.getByTestId("mfa-floating-pin"));
    expect(useAppStore.getState().floatingMfa.pinned).toBe(true);
    fireEvent.click(screen.getByTestId("mfa-floating-close"));
    expect(useAppStore.getState().floatingMfa.open).toBe(false);
  });
});
