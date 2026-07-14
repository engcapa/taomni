import { describe, expect, it } from "vitest";
import type { GitWorkspaceRootInfo } from "../types";
import {
  decideWorkspaceGitSync,
  filterSnapshotRoots,
  isMissingRepoPathError,
  resolveActiveRepoRoot,
  retainDeadRepoRoots,
} from "./workspaceGitManagerSync";

function root(repoRoot: string, name = repoRoot.split("/").pop() ?? repoRoot): GitWorkspaceRootInfo {
  return {
    id: name,
    name,
    path: repoRoot,
    repoRoot,
    rootIds: [name],
  };
}

describe("isMissingRepoPathError", () => {
  it("recognizes os error 267 and missing-directory messages", () => {
    expect(isMissingRepoPathError("failed to start git: os error 267")).toBe(true);
    expect(isMissingRepoPathError("The directory name is invalid. (os error 267)")).toBe(true);
    expect(isMissingRepoPathError("Repository path no longer exists: /gone")).toBe(true);
    expect(isMissingRepoPathError("Repository path is not a directory: /file")).toBe(true);
    expect(isMissingRepoPathError("No such file or directory (os error 2)")).toBe(true);
    expect(isMissingRepoPathError("authentication failed")).toBe(false);
    expect(isMissingRepoPathError("conflict in merge")).toBe(false);
  });
});

describe("decideWorkspaceGitSync", () => {
  it("is a no-op when no linked git tab exists", () => {
    expect(decideWorkspaceGitSync({
      hasLinkedTab: false,
      workspaceRoots: [root("/repo/a")],
    })).toEqual({ kind: "noop" });
  });

  it("closes the linked tab when workspace git roots become empty", () => {
    expect(decideWorkspaceGitSync({
      hasLinkedTab: true,
      workspaceRoots: [],
      existingActiveRepoRoot: "/repo/a",
    })).toEqual({ kind: "close" });
  });

  it("updates roots and preserves active repo when still present", () => {
    const roots = [root("/repo/a", "a"), root("/repo/b", "b")];
    expect(decideWorkspaceGitSync({
      hasLinkedTab: true,
      workspaceRoots: roots,
      existingActiveRepoRoot: "/repo/b",
      payloadActiveRepoRoot: "/repo/a",
    })).toEqual({
      kind: "update",
      workspaceRoots: roots,
      activeRepoRoot: "/repo/b",
    });
  });

  it("falls back when the previous active repo was removed", () => {
    const roots = [root("/repo/a", "a")];
    expect(decideWorkspaceGitSync({
      hasLinkedTab: true,
      workspaceRoots: roots,
      existingActiveRepoRoot: "/repo/gone",
      payloadActiveRepoRoot: "/repo/a",
    })).toEqual({
      kind: "update",
      workspaceRoots: roots,
      activeRepoRoot: "/repo/a",
    });
  });
});

describe("filterSnapshotRoots / retainDeadRepoRoots", () => {
  it("skips dead repo roots for snapshotting", () => {
    const roots = [root("/repo/a", "a"), root("/repo/b", "b")];
    const dead = new Set(["/repo/b"]);
    expect(filterSnapshotRoots(roots, dead).map((r) => r.repoRoot)).toEqual(["/repo/a"]);
  });

  it("drops dead markers for roots no longer in the workspace set", () => {
    const next = retainDeadRepoRoots(new Set(["/repo/a", "/repo/gone"]), [root("/repo/a", "a")]);
    expect([...next]).toEqual(["/repo/a"]);
  });
});

describe("resolveActiveRepoRoot", () => {
  it("returns null for an empty root list", () => {
    expect(resolveActiveRepoRoot([], "/a", "/b")).toBeNull();
  });
});
