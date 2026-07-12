import { describe, expect, it } from "vitest";
import { formatLocalHistoryTime } from "./localHistory";

describe("localHistory helpers", () => {
  it("formats recent and absolute timestamps", () => {
    const now = 1_000_000_000_000;
    expect(formatLocalHistoryTime(now / 1000, now)).toBe("just now");
    expect(formatLocalHistoryTime((now - 5 * 60_000) / 1000, now)).toBe("5m ago");
    expect(formatLocalHistoryTime((now - 3 * 60 * 60_000) / 1000, now)).toBe("3h ago");
    expect(formatLocalHistoryTime((now - 3 * 24 * 60 * 60_000) / 1000, now)).toMatch(/\d/);
  });
});
