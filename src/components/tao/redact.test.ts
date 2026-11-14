import { describe, expect, it } from "vitest";
import { redactText, redactionRuleNames } from "./redact";

describe("Tao write-time redaction", () => {
  it("covers credentials required by the local-index gate", () => {
    const result = redactText("AKIA1234567890ABCDEF ghp_1234567890123456789012345678901234567890 eyJabc.def.ghi postgres://u:p@example.test/db");
    expect(result.count).toBeGreaterThanOrEqual(4);
    expect(result.text).not.toContain("AKIA1234567890ABCDEF");
    expect(result.text).not.toContain("postgres://u:p@example.test/db");
    expect(redactionRuleNames()).toEqual(expect.arrayContaining(["private-key", "aws", "github", "jwt", "connection", "x-api-key"]));
  });

  it("preserves surrounding command text", () => {
    expect(redactText("echo password=secret && ls -la").text).toBe("echo [已脱敏] && ls -la");
  });
});
