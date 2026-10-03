import { describe, expect, it } from "vitest";
import {
  parseWorkspaceChangeKey,
  retainWorkspaceChangeKeys,
  workspaceChangeKey,
  workspacePathsByRepoFromKeys,
} from "./workspaceGitKeys";

describe("workspaceGitKeys", () => {
  it("round-trips repository roots and paths without collapsing identical file names", () => {
    const appReadme = workspaceChangeKey("/repo/app", "README.md");
    const serviceReadme = workspaceChangeKey("/repo/service", "README.md");

    expect(appReadme).not.toBe(serviceReadme);
    expect(parseWorkspaceChangeKey(appReadme)).toEqual({
      repoRoot: "/repo/app",
      path: "README.md",
    });
    expect(parseWorkspaceChangeKey(serviceReadme)).toEqual({
      repoRoot: "/repo/service",
      path: "README.md",
    });
  });

  it("groups selected workspace keys by repository and skips invalid keys", () => {
    expect(workspacePathsByRepoFromKeys([
      workspaceChangeKey("/repo/app", "README.md"),
      "invalid",
      workspaceChangeKey("/repo/service", "README.md"),
      workspaceChangeKey("/repo/app", "src/App.tsx"),
    ])).toEqual({
      "/repo/app": ["README.md", "src/App.tsx"],
      "/repo/service": ["README.md"],
    });
  });

  it("retains only keys that still exist", () => {
    const appReadme = workspaceChangeKey("/repo/app", "README.md");
    const serviceReadme = workspaceChangeKey("/repo/service", "README.md");
    const current = new Set([appReadme, serviceReadme]);
    const valid = new Set([serviceReadme]);

    expect(retainWorkspaceChangeKeys(current, valid)).toEqual(new Set([serviceReadme]));
    expect(retainWorkspaceChangeKeys(valid, valid)).toBe(valid);
  });
});
