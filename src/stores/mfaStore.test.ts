import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  mfaList: vi.fn(),
  mfaCodes: vi.fn(),
  mfaAdd: vi.fn(),
  mfaInspect: vi.fn(),
  mfaUpdate: vi.fn(),
  mfaDelete: vi.fn(),
  mfaReorder: vi.fn(),
  mfaHotpNext: vi.fn(),
  mfaMarkUsed: vi.fn(),
  mfaSetPrefs: vi.fn(),
  mfaResetStore: vi.fn(),
}));
const writeText = vi.hoisted(() => vi.fn(async (_text: string) => undefined));
const vaultRefresh = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../lib/mfa/ipc", () => ipc);
vi.mock("../lib/clipboard", () => ({ writeText }));
vi.mock("./vaultStore", () => ({ useVaultStore: { getState: () => ({ refresh: vaultRefresh }) } }));

import type { MfaAccount } from "../lib/mfa/types";
import { useMfaStore } from "./mfaStore";

const account = (id: string, sortOrder: number): MfaAccount => ({
  id,
  issuer: id,
  accountName: "",
  group: "",
  note: "",
  kind: "totp",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  counter: 0,
  pinned: false,
  sortOrder,
  useCount: 0,
  lastUsedAt: null,
  createdAt: sortOrder,
  updatedAt: sortOrder,
});

describe("mfaStore", () => {
  beforeEach(() => {
    Object.values(ipc).forEach((fn) => fn.mockReset());
    writeText.mockClear();
    vaultRefresh.mockClear();
    useMfaStore.setState({ status: "idle", accounts: [], codes: {}, error: null, errorCode: null, lastCopied: null, query: "" });
  });

  it("loads accounts and codes, then copies and records usage", async () => {
    ipc.mfaList.mockResolvedValue({ accounts: [account("a", 0)], prefs: { sortMode: "recent", groupFilter: "" } });
    ipc.mfaCodes.mockResolvedValue([{ id: "a", code: "123456", nextCode: "654321", period: 30, counter: 1, validFromMs: 0, validUntilMs: 30_000 }]);
    ipc.mfaMarkUsed.mockResolvedValue({ ...account("a", 0), useCount: 1, lastUsedAt: 5 });
    await useMfaStore.getState().load();
    expect(useMfaStore.getState()).toMatchObject({ status: "ready", prefs: { sortMode: "recent" } });

    await expect(useMfaStore.getState().copyCode("a", "next")).resolves.toBe("654321");
    expect(writeText).toHaveBeenCalledWith("654321");
    await vi.waitFor(() => expect(useMfaStore.getState().accounts[0].useCount).toBe(1));
  });

  it("sends a locked vault back to its gate and keeps the error code", async () => {
    ipc.mfaList.mockRejectedValue("VAULT_LOCKED");
    await useMfaStore.getState().load();
    expect(useMfaStore.getState()).toMatchObject({ status: "error", errorCode: "VAULT_LOCKED" });
    expect(vaultRefresh).toHaveBeenCalled();

    ipc.mfaList.mockRejectedValue(new Error("MFA_KEY_MISSING"));
    await useMfaStore.getState().load();
    expect(useMfaStore.getState().errorCode).toBe("MFA_KEY_MISSING");
  });

  it("reorders optimistically and rolls back when persisting fails", async () => {
    useMfaStore.setState({ accounts: [account("a", 0), account("b", 1), account("c", 2)] });
    ipc.mfaReorder.mockRejectedValueOnce(new Error("disk full"));
    await expect(useMfaStore.getState().moveAccount("c", "a")).rejects.toThrow("disk full");
    expect(useMfaStore.getState().accounts.map((a) => a.sortOrder)).toEqual([0, 1, 2]);

    ipc.mfaReorder.mockResolvedValueOnce(undefined);
    await useMfaStore.getState().moveAccount("c", "a");
    expect(ipc.mfaReorder).toHaveBeenLastCalledWith(["c", "a", "b"]);
    expect(Object.fromEntries(useMfaStore.getState().accounts.map((a) => [a.id, a.sortOrder]))).toEqual({ c: 0, a: 1, b: 2 });
  });
});
