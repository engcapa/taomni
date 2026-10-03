import { beforeEach, describe, expect, it } from "vitest";
import { defaultMfaInput, type MfaAccount, type MfaCode } from "../lib/mfa/types";
import { MFA_STUB_STORAGE_KEY, stubHotp, stubMfaInvoke } from "./mfaStub";

const RFC4226 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const call = (cmd: string, args?: Record<string, unknown>) => stubMfaInvoke(cmd, args, true);

describe("MFA browser stub", () => {
  beforeEach(() => localStorage.removeItem(MFA_STUB_STORAGE_KEY));

  it("matches RFC 4226 / RFC 6238 vectors through WebCrypto", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    await expect(stubHotp(secret, 0, 6, "SHA1")).resolves.toBe("755224");
    await expect(stubHotp(secret, 9, 6, "SHA1")).resolves.toBe("520489");
    await expect(stubHotp(secret, Math.floor(1_111_111_109 / 30), 8, "SHA1")).resolves.toBe("07081804");
    const sha256 = new TextEncoder().encode("12345678901234567890123456789012");
    await expect(stubHotp(sha256, Math.floor(20_000_000_000 / 30), 8, "SHA256")).resolves.toBe("77737706");
  });

  it("adds, generates, advances, orders and persists accounts", async () => {
    const hotp = { ...defaultMfaInput(), issuer: "QA Bank", accountName: "qa", secret: RFC4226.toLowerCase(), kind: "hotp" as const };
    const totp = { ...defaultMfaInput(), issuer: "GitHub", accountName: "dev", secret: "JBSW Y3DP EHPK 3PXP" };
    const added = (await call("mfa_add", { inputs: [hotp, totp], skipDuplicates: true })) as { added: MfaAccount[] };
    expect(added.added.map((a) => a.issuer)).toEqual(["QA Bank", "GitHub"]);
    expect(added.added[0]).not.toHaveProperty("secret");

    const codes = (await call("mfa_codes")) as MfaCode[];
    expect(codes[0]).toMatchObject({ code: "755224", nextCode: null, validUntilMs: null });
    expect(codes[1].code).toMatch(/^\d{6}$/);
    expect(codes[1].validUntilMs! - codes[1].validFromMs!).toBe(30_000);
    await expect(call("mfa_hotp_next", { id: added.added[0].id })).resolves.toMatchObject({ code: "287082", counter: 1 });

    const dup = (await call("mfa_add", { inputs: [hotp], skipDuplicates: true })) as { added: MfaAccount[]; duplicates: number[] };
    expect(dup).toEqual({ added: [], duplicates: [0] });
    await expect(call("mfa_add", { inputs: [hotp], skipDuplicates: false })).rejects.toThrow(/already exists/);
    const inspected = (await call("mfa_inspect", { inputs: [hotp, { ...totp, secret: "bad!" }] })) as Array<{ duplicateOf: string | null; error: string | null }>;
    expect(inspected[0].duplicateOf).toBe(added.added[0].id);
    expect(inspected[1].error).toMatch(/^MFA_INVALID_INPUT: secret/);

    await call("mfa_reorder", { ids: [added.added[1].id] });
    await call("mfa_set_prefs", { prefs: { sortMode: "issuer", groupFilter: "Work" } });
    const snapshot = (await call("mfa_list")) as { accounts: MfaAccount[]; prefs: { sortMode: string } };
    expect(snapshot.accounts.map((a) => a.issuer)).toEqual(["GitHub", "QA Bank"]);
    expect(snapshot.accounts[1].counter).toBe(1);
    expect(snapshot.prefs).toEqual({ sortMode: "issuer", groupFilter: "Work" });
    await expect(call("mfa_set_prefs", { prefs: { sortMode: "random", groupFilter: "" } })).rejects.toThrow(/sortMode/);
  });

  it("enforces the vault gate and desktop-only sources", async () => {
    await expect(stubMfaInvoke("mfa_list", undefined, false)).rejects.toThrow("VAULT_LOCKED");
    await expect(call("mfa_capture_screens")).rejects.toThrow("MFA_DESKTOP_ONLY");
    await expect(call("mfa_read_clipboard_image")).rejects.toThrow("MFA_DESKTOP_ONLY");
    await expect(call("mfa_delete", { id: "missing" })).rejects.toThrow("MFA_NOT_FOUND");
  });

  it("exports an otpauth link only with the stub vault's master password", async () => {
    const input = { ...defaultMfaInput(), issuer: "QA Bank", accountName: "qa@example.com", secret: "jbsw y3dp ehpk 3pxp" };
    const { added } = (await call("mfa_add", { inputs: [input], skipDuplicates: false })) as { added: MfaAccount[] };
    const exportWith = (masterPassword: string) =>
      stubMfaInvoke("mfa_export_uri", { id: added[0].id, masterPassword }, true, "qa-master");
    await expect(exportWith("")).rejects.toThrow("VAULT_PASSWORD_REQUIRED");
    await expect(exportWith("wrong")).rejects.toThrow("VAULT_BAD_PASSWORD");
    await expect(exportWith("qa-master")).resolves.toBe(
      "otpauth://totp/QA%20Bank:qa%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=QA%20Bank&algorithm=SHA1&digits=6&period=30",
    );
    await expect(stubMfaInvoke("mfa_export_uri", { id: added[0].id, masterPassword: "qa-master" }, false, "qa-master")).rejects.toThrow("VAULT_LOCKED");
  });
});
