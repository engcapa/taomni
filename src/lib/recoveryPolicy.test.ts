import { describe, expect, it } from "vitest";
import { RECOVERY_LIMITATIONS, recoveryLimitation } from "./recoveryPolicy";
describe("fail-closed recovery policy", () => {
  it("has an explicit explanation for every current tab kind, not an automatic connect default", () => {
    expect(Object.keys(RECOVERY_LIMITATIONS)).toHaveLength(21);
    for (const [kind, limitation] of Object.entries(RECOVERY_LIMITATIONS)) {
      expect(recoveryLimitation(kind)).toBe(limitation);
      expect(limitation.length).toBeGreaterThan(20);
    }
  });
  it("does not mistake HBase REST, proxy tests or placeholders for PTYs", () => {
    expect(recoveryLimitation("hbase-shell")).toContain("不是 PTY");
    expect(recoveryLimitation("proxy-test")).toContain("不自动重复");
    expect(recoveryLimitation("placeholder")).toContain("不触发");
  });
  it("fails closed on unknown and inherited property names", () => {
    expect(recoveryLimitation("new-protocol")).toContain("未识别");
    expect(recoveryLimitation("__proto__")).toContain("未识别");
  });
});
