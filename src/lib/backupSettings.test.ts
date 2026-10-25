import { describe, expect, it } from "vitest";
import { rangeOptions, globalRange } from "./backupSettings";
import type { BackupRange, BackupPolicy } from "./backup";

describe("backup category compatibility", () => {
  it.each(["core", "full", "custom"] as const)("expands legacy %s without changing the stored policy", (scope) => {
    const policy: BackupPolicy = { autoBackupEnabled: false, frequency: "weekly", maxRetainedCopies: 7, defaultScope: scope };
    const before = JSON.stringify(policy);
    const options = rangeOptions(globalRange(policy));
    expect(options.includeSessions).toBe(true);
    expect(options.includeMail).toBe(scope === "full");
    expect(options.includeMailOriginals).toBe(scope === "full");
    expect(options.includeMailAttachments).toBe(scope === "full");
    expect(options.includeServerCertificates).toBe(scope !== "custom");
    expect(JSON.stringify(policy)).toBe(before);
  });
  it("preserves explicit mail exclusion in full and includes every legacy mail child when enabled", () => {
    for (const scope of ["core", "full"] as const) {
      const options = rangeOptions({ scope, customOptions: { includeMail: false } });
      expect(options.includeMail || options.includeMailOriginals || options.includeMailAttachments).toBe(false);
    }
    const legacy = rangeOptions({ scope: "custom", customOptions: { includeMail: true } });
    expect(legacy.includeMailOriginals && legacy.includeMailAttachments).toBe(true);
    expect(legacy.includeSessions || legacy.includeServerCertificates).toBe(false);
  });
  it("preserves separate mail children and MFA dependency", () => {
    const range: BackupRange = { scope: "custom", customOptions: { includeMail: true, includeMailOriginals: false, includeMailAttachments: true, includeMfa: true } };
    expect(rangeOptions(range)).toMatchObject({ includeMail: true, includeMailOriginals: false, includeMailAttachments: true, includeMfa: true, includeVault: true });
  });
});
