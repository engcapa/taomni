import { describe, expect, it } from "vitest";
import type { GitChange } from "./git";
import type { GitWorkspaceRootInfo } from "../types";
import {
  buildWorkspaceFlatGroups,
  changeFileName,
  changePathDirectory,
} from "./workspaceGitFlatList";

function root(name: string, repoRoot: string): GitWorkspaceRootInfo {
  return { id: name, name, path: repoRoot, repoRoot, rootIds: [name] };
}

function change(path: string): GitChange {
  return {
    path,
    oldPath: null,
    status: "modified",
    staged: false,
    unstaged: true,
    conflict: false,
  };
}

describe("buildWorkspaceFlatGroups", () => {
  it("groups by project name and sorts files under each project", () => {
    const roots = [root("service", "/r/service"), root("app", "/r/app")];
    const map = new Map<string, GitChange[]>([
      ["/r/service", [change("b.ts"), change("a.ts")]],
      ["/r/app", [change("src/z.ts"), change("src/a.ts")]],
    ]);
    const groups = buildWorkspaceFlatGroups(roots, map);
    expect(groups.map((g) => g.root.name)).toEqual(["app", "service"]);
    expect(groups[0].changes.map((c) => c.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(groups[1].changes.map((c) => c.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("skips empty repositories", () => {
    const groups = buildWorkspaceFlatGroups(
      [root("app", "/r/app"), root("empty", "/r/empty")],
      new Map([["/r/app", [change("x.ts")]]]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].root.name).toBe("app");
  });
});

describe("compact path helpers", () => {
  it("splits filename and directory for single-line rows", () => {
    expect(changeFileName("src/http/handler.ts")).toBe("handler.ts");
    expect(changePathDirectory("src/http/handler.ts")).toBe("src/http");
    expect(changePathDirectory("README.md")).toBe("");
  });
});
