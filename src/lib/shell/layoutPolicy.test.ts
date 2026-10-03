import { describe, expect, it } from "vitest";
import { solveShellLayout } from "./layoutPolicy";

const request = { width: 1440, height: 900, navigatorRequested: true, navigatorWidth: 248, rightRequested: true };
describe("Shell space arbitration", () => {
  it("fits normal docks and preserves the primary minimum when several sides are requested", () => {
    expect(solveShellLayout(request)).toMatchObject({ navigator: "dock", right: "dock", titlebarHeight: 42 });
    expect(solveShellLayout({ ...request, taoOpen: true, taoEdge: "left", taoPinned: true })).toMatchObject({ navigator: "hidden", right: "dock" });
    expect(solveShellLayout({ ...request, width: 1200, taoOpen: true, taoEdge: "left", taoPinned: true }).right).toBe("overlay");
  });
  it("suppresses only the same edge and restores original intent from the unchanged request", () => {
    expect(solveShellLayout({ ...request, bottomRequested: true, taoOpen: true, taoEdge: "right" })).toMatchObject({ right: "hidden", bottom: "dock" });
    expect(solveShellLayout(request).right).toBe("dock");
  });
  it("keeps all controls reachable at 200% scaling and very low height", () => {
    const narrow = solveShellLayout({ ...request, width: 400, height: 300, bottomRequested: true });
    expect(narrow).toMatchObject({ titlebarHeight: 84, navigator: "overlay", right: "overlay", bottom: "overlay", mode: "compact" });
    expect(narrow.rightSize).toBeLessThanOrEqual(332);
    expect(narrow.bottomSize).toBeLessThanOrEqual(narrow.bodyHeight - 16);
    expect(solveShellLayout({ ...request, height: 400, bottomRequested: true }).bottom).toBe("overlay");
  });
});
