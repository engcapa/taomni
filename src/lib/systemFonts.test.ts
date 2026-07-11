import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CASCADIA_MONO,
  MENLO,
  getDefaultTerminalFontFamily,
  getDefaultTerminalFontName,
  isMonospaceFont,
  resetSystemFontCacheForTests,
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

describe("isMonospaceFont", () => {
  beforeEach(() => {
    resetSystemFontCacheForTests();
  });

  it("caches font classification by normalized family name", () => {
    const measureText = vi.fn(() => ({ width: 10 }));
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      measureText,
    } as unknown as CanvasRenderingContext2D);

    expect(isMonospaceFont("Cached Mono")).toBe(true);
    expect(isMonospaceFont(" cached mono ")).toBe(true);
    expect(measureText).toHaveBeenCalledTimes(9);
  });

  it("caches proportional font results", () => {
    const measureText = vi.fn()
      .mockReturnValueOnce({ width: 5 })
      .mockReturnValueOnce({ width: 10 });
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      measureText,
    } as unknown as CanvasRenderingContext2D);

    expect(isMonospaceFont("Cached Sans")).toBe(false);
    expect(isMonospaceFont("Cached Sans")).toBe(false);
    expect(measureText).toHaveBeenCalledTimes(2);
  });
});
