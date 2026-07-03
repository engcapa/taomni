import { describe, expect, it, vi } from "vitest";
import {
  CASCADIA_MONO,
  MENLO,
  getDefaultTerminalFontFamily,
  getDefaultTerminalFontName,
} from "./systemFonts";

const runtimeMocks = vi.hoisted(() => ({
  platform: "linux" as string,
}));

vi.mock("./runtime", () => ({
  getAppPlatform: () => runtimeMocks.platform,
}));

describe("systemFonts terminal defaults", () => {
  it.each([
    ["linux", CASCADIA_MONO],
    ["windows", CASCADIA_MONO],
    ["macos", MENLO],
  ])("uses the expected terminal default font on %s", (platform, expected) => {
    runtimeMocks.platform = platform;

    expect(getDefaultTerminalFontName()).toBe(expected);
    expect(getDefaultTerminalFontFamily()).toContain(`"${expected}"`);
  });
});
