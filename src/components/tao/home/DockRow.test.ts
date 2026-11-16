import { describe, expect, it } from "vitest";
import { shouldShowWslEntry } from "./DockRow";

describe("Tao Home WSL entry", () => {
  it("only exposes WSL when discovery is ready and has a distro", () => {
    expect(shouldShowWslEntry("loading", 1)).toBe(false);
    expect(shouldShowWslEntry("unsupported", 0)).toBe(false);
    expect(shouldShowWslEntry("error", 0)).toBe(false);
    expect(shouldShowWslEntry("ready", 0)).toBe(false);
    expect(shouldShowWslEntry("ready", 1)).toBe(true);
  });
});
