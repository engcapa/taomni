import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MfaCode, MfaSnapshot } from "../lib/mfa/types";
import { deferred, mfaAccount, mfaCode } from "../test/mfaHarness";

const vault = vi.hoisted(() => ({
  vaultStatus: vi.fn(), vaultInit: vi.fn(), vaultUnlock: vi.fn(), vaultLock: vi.fn(),
  vaultChangeMaster: vi.fn(), vaultDelete: vi.fn(), vaultList: vi.fn(),
}));
const mfa = vi.hoisted(() => ({
  mfaList: vi.fn(), mfaCodes: vi.fn(), mfaInspect: vi.fn(), mfaAdd: vi.fn(), mfaUpdate: vi.fn(),
  mfaDelete: vi.fn(), mfaReorder: vi.fn(), mfaHotpNext: vi.fn(), mfaMarkUsed: vi.fn(), mfaResetStore: vi.fn(), mfaSetPrefs: vi.fn(),
}));
const writeText = vi.hoisted(() => vi.fn(async (_text: string) => undefined));
vi.mock("../lib/ipc", () => vault);
vi.mock("../lib/mfa/ipc", () => mfa);
vi.mock("../lib/clipboard", () => ({ writeText }));

import { useVaultStore } from "./vaultStore";
import { useMfaStore } from "./mfaStore";
import { usePluginFrontendStore } from "./pluginFrontendStore";

beforeEach(() => {
  Object.values(vault).forEach((fn) => fn.mockReset());
  Object.values(mfa).forEach((fn) => fn.mockReset());
  writeText.mockClear();
  vault.vaultStatus.mockResolvedValue({ state: "unlocked", entry_count: 1 });
  useVaultStore.setState({ state: "unlocked", entryCount: 1, entries: [], loading: false,
    securityEpoch: useVaultStore.getState().securityEpoch + 1, transitionPending: false, requiresUnlock: false });
  useMfaStore.setState({ status: "ready", accounts: [mfaAccount()], codes: { account: mfaCode() }, error: null, errorCode: null, lastCopied: { id: "account", at: 1 } });
});

describe("Vault requests invalidate sensitive MFA work", () => {
  it("clears codes and rejects old replies when the MFA renderer loses its activation", async () => {
    const codes = deferred<MfaCode[]>();
    mfa.mfaCodes.mockReturnValueOnce(codes.promise);
    const request = useMfaStore.getState().refreshCodes();
    usePluginFrontendStore.setState((state) => ({ epochs: { ...state.epochs, mfa: (state.epochs.mfa ?? 0) + 1 } }));
    expect(useVaultStore.getState().state).toBe("unlocked");
    expect(useMfaStore.getState()).toMatchObject({ status: "idle", accounts: [], codes: {}, lastCopied: null });
    codes.resolve([mfaCode("287082")]);
    await request;
    expect(useMfaStore.getState().codes).toEqual({});
  });

  it("hides existing codes immediately and discards list/code replies before lock confirmation", async () => {
    const lock = deferred<void>();
    const codes = deferred<MfaCode[]>();
    const list = deferred<MfaSnapshot>();
    vault.vaultLock.mockReturnValue(lock.promise);
    mfa.mfaCodes.mockReturnValue(codes.promise);
    mfa.mfaList.mockReturnValue(list.promise);
    const codeRequest = useMfaStore.getState().refreshCodes();
    const listRequest = useMfaStore.getState().load();
    const locking = useVaultStore.getState().lock();
    expect(useVaultStore.getState()).toMatchObject({ state: "locked", transitionPending: true });
    expect(useMfaStore.getState()).toMatchObject({ accounts: [], codes: {}, lastCopied: null });
    codes.resolve([mfaCode("287082")]);
    list.resolve({ accounts: [mfaAccount()], prefs: { sortMode: "custom", groupFilter: "" } });
    await Promise.all([codeRequest, listRequest]);
    expect(useMfaStore.getState()).toMatchObject({ status: "idle", accounts: [], codes: {} });
    lock.resolve();
    await locking;
  });

  it("keeps a failed lock gated despite stale unlocked status and recovers only through explicit unlock", async () => {
    vault.vaultLock.mockRejectedValue(new Error("host cleanup timed out"));
    await expect(useVaultStore.getState().lock()).rejects.toThrow("host cleanup timed out");
    await useVaultStore.getState().refresh();
    expect(useVaultStore.getState()).toMatchObject({ state: "locked", requiresUnlock: true, transitionPending: false });
    expect(useMfaStore.getState().codes).toEqual({});
    await useVaultStore.getState().unlock("verified-password");
    expect(useVaultStore.getState()).toMatchObject({ state: "unlocked", requiresUnlock: false, transitionPending: false });
  });

  it("clears codes on native admission rejection before status returns and requires verified recovery", async () => {
    const status = deferred<{ state: string; entry_count: number }>();
    vault.vaultStatus.mockReturnValueOnce(status.promise);
    mfa.mfaCodes.mockRejectedValueOnce(new Error("VAULT_LOCKED"));
    await expect(useMfaStore.getState().refreshCodes()).rejects.toThrow("VAULT_LOCKED");
    expect(useVaultStore.getState()).toMatchObject({ state: "locked", requiresUnlock: true });
    expect(useMfaStore.getState()).toMatchObject({ accounts: [], codes: {}, lastCopied: null });
    status.resolve({ state: "unlocked", entry_count: 1 });
    await Promise.resolve();
    expect(useVaultStore.getState()).toMatchObject({ state: "locked", requiresUnlock: true });
    await useVaultStore.getState().unlock("verified-password");
    expect(useVaultStore.getState()).toMatchObject({ state: "unlocked", requiresUnlock: false });
  });

  it("starts a new full code request after unlock without joining or clearing the old request", async () => {
    const old = deferred<MfaCode[]>();
    const next = deferred<MfaCode[]>();
    mfa.mfaCodes.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const first = useMfaStore.getState().refreshCodes();
    await useVaultStore.getState().lock();
    await useVaultStore.getState().unlock("verified-password");
    const second = useMfaStore.getState().refreshCodes();
    old.resolve([mfaCode("old-code")]);
    await first;
    const joined = useMfaStore.getState().refreshCodes();
    expect(mfa.mfaCodes).toHaveBeenCalledTimes(2);
    expect(useMfaStore.getState().codes).toEqual({});
    next.resolve([mfaCode("287082")]);
    await Promise.all([second, joined]);
    expect(useMfaStore.getState().codes.account.code).toBe("287082");
  });

  it("rejects a late HOTP result and never restores code or counter after locking", async () => {
    const code = deferred<MfaCode>();
    mfa.mfaHotpNext.mockReturnValue(code.promise);
    const advancing = useMfaStore.getState().hotpNext("account");
    const rejected = expect(advancing).rejects.toThrow("VAULT_LOCKED");
    await useVaultStore.getState().lock();
    code.resolve({ ...mfaCode("287082"), counter: 1 });
    await rejected;
    expect(useMfaStore.getState()).toMatchObject({ accounts: [], codes: {}, error: null });
  });

  it("does not roll back old accounts when a reorder fails after locking", async () => {
    const reorder = deferred<void>();
    mfa.mfaReorder.mockReturnValue(reorder.promise);
    const moving = useMfaStore.getState().moveAccount("account", "account");
    const rejected = expect(moving).rejects.toThrow("disk unavailable");
    await useVaultStore.getState().lock();
    reorder.reject(new Error("disk unavailable"));
    await rejected;
    expect(useMfaStore.getState()).toMatchObject({ accounts: [], codes: {}, error: null });
  });

  it("discards a late usage update and prevents copying after lock receipt", async () => {
    const usage = deferred<ReturnType<typeof mfaAccount>>();
    mfa.mfaMarkUsed.mockReturnValue(usage.promise);
    await useMfaStore.getState().copyCode("account");
    await useVaultStore.getState().lock();
    usage.resolve({ ...mfaAccount(), useCount: 1 });
    await Promise.resolve();
    expect(useMfaStore.getState()).toMatchObject({ accounts: [], codes: {}, lastCopied: null });
    await expect(useMfaStore.getState().copyCode("account")).resolves.toBeNull();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("serializes a requested unlock after an unconfirmed lock", async () => {
    const lock = deferred<void>();
    vault.vaultLock.mockReturnValue(lock.promise);
    const locking = useVaultStore.getState().lock();
    const unlocking = useVaultStore.getState().unlock("verified-password");
    await vi.waitFor(() => expect(vault.vaultLock).toHaveBeenCalledOnce());
    expect(vault.vaultUnlock).not.toHaveBeenCalled();
    expect(useVaultStore.getState().state).toBe("locked");
    lock.resolve();
    await Promise.all([locking, unlocking]);
    expect(vault.vaultUnlock).toHaveBeenCalledOnce();
    expect(useVaultStore.getState()).toMatchObject({ state: "unlocked", transitionPending: false });
  });

  it("ignores status and entry results requested before the lock epoch", async () => {
    const status = deferred<{ state: string; entry_count: number }>();
    const entries = deferred<never[]>();
    vault.vaultStatus.mockReturnValue(status.promise);
    vault.vaultList.mockReturnValue(entries.promise);
    const refreshing = useVaultStore.getState().refresh();
    const listing = useVaultStore.getState().reloadEntries();
    await useVaultStore.getState().lock();
    status.resolve({ state: "unlocked", entry_count: 50 });
    entries.resolve([]);
    await Promise.all([refreshing, listing]);
    expect(useVaultStore.getState()).toMatchObject({ state: "locked", entryCount: 1, entries: [] });
  });

  it("invalidates old code replies during explicit reset and reloads the empty store", async () => {
    const old = deferred<MfaCode[]>();
    const reset = deferred<void>();
    mfa.mfaCodes.mockReturnValueOnce(old.promise).mockResolvedValue([]);
    mfa.mfaResetStore.mockReturnValue(reset.promise);
    mfa.mfaList.mockResolvedValue({ accounts: [], prefs: { sortMode: "custom", groupFilter: "" } });
    const previous = useMfaStore.getState().refreshCodes();
    const resetting = useMfaStore.getState().resetStore();
    expect(useMfaStore.getState()).toMatchObject({ accounts: [], codes: {}, status: "loading" });
    await useMfaStore.getState().refreshCodes();
    expect(mfa.mfaCodes).toHaveBeenCalledOnce();
    old.resolve([mfaCode("stale-code")]);
    await previous;
    expect(useMfaStore.getState().codes).toEqual({});
    reset.resolve();
    await resetting;
    expect(useMfaStore.getState()).toMatchObject({ accounts: [], codes: {}, status: "ready" });
    expect(mfa.mfaList).toHaveBeenCalledOnce();
  });
});
