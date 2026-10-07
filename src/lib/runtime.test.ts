import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppPlatform } from "./runtime";

afterEach(() => vi.restoreAllMocks());

describe("host platform detection", () => {
  it.each([
    ["Linux x86_64", "Mozilla/5.0 (Windows NT 10.0)", "linux"],
    ["Win32", "Mozilla/5.0 (Macintosh)", "windows"],
    ["MacIntel", "Mozilla/5.0 (Linux)", "macos"],
    ["", "Mozilla/5.0 (Windows NT 10.0)", "windows"],
    ["", "Mozilla/5.0 (X11; Linux x86_64)", "linux"],
    ["unknown", "unknown", "unknown"],
  ])("resolves %s with UA %s to %s", (platform, userAgent, expected) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    expect(getAppPlatform()).toBe(expected);
  });
});
