import { afterEach, describe, expect, it, vi } from "vitest";
import { createScreenshotFavoritesFault } from "./screenshotFavoritesFault";

afterEach(() => vi.useRealTimers());
describe("favorite read fault", () => {
  it("fails duplicate initial reads and allows a later explicit retry", () => {
    vi.useFakeTimers();
    const fails = createScreenshotFavoritesFault();
    expect(fails("once")).toBe(true);
    expect(fails("once")).toBe(true);
    vi.advanceTimersByTime(0);
    expect(fails("once")).toBe(false);
    expect(fails("once")).toBe(false);
  });
  it("leaves normal loads intact and can keep a permanent failure", () => {
    vi.useFakeTimers();
    const fails = createScreenshotFavoritesFault();
    expect(fails(null)).toBe(false);
    expect(fails("always")).toBe(true);
    vi.advanceTimersByTime(0);
    expect(fails("always")).toBe(true);
    expect(fails("once")).toBe(true);
  });
});
