import { describe, expect, it } from "vitest";
import { formatDateWithPattern } from "./PickerDialogs";

describe("notepad custom date insertion", () => {
  const date = new Date(2026, 10, 21, 9, 5, 7);

  it("expands the documented tokens with zero padding", () => {
    expect(formatDateWithPattern(date, "yyyy-MM-dd HH:mm:ss")).toBe("2026-11-21 09:05:07");
    expect(formatDateWithPattern(date, "yy/M/d H:m:s")).toBe("26/11/21 9:5:7");
  });

  it("keeps non-token literals and does not expand unknown tokens", () => {
    expect(formatDateWithPattern(date, "yyyy年MM月dd日 HH:mm:ss")).toBe("2026年11月21日 09:05:07");
    expect(formatDateWithPattern(date, "yyyy-QQ")).toBe("2026-QQ");
  });
});
