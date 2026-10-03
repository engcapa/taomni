import { describe, expect, it } from "vitest";
import { buildPathTree, collectFilePaths, type ChangeTreeDir } from "./gitTree";
import type { GitChange } from "./git";

function change(path: string, status = "modified"): GitChange {
  return { path, oldPath: null, status, staged: false, unstaged: true, conflict: false };
}

describe("buildPathTree", () => {
  it("nests files under directories", () => {
    const tree = buildPathTree([change("src/a.ts"), change("src/b.ts"), change("readme.md")]);
    // dirs sort before files: [src/, readme.md]
    expect(tree[0].type).toBe("dir");
    expect(tree[0].name).toBe("src");
    expect((tree[0] as ChangeTreeDir).children.map((c) => c.name)).toEqual(["a.ts", "b.ts"]);
    expect(tree[1].type).toBe("file");
    expect(tree[1].name).toBe("readme.md");
  });

  it("compacts single-child directory chains", () => {
    const tree = buildPathTree([change("src/main/java/App.java")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe("dir");
    expect(tree[0].name).toBe("src/main/java");
    expect(tree[0].path).toBe("src/main/java");
    expect((tree[0] as ChangeTreeDir).children[0].name).toBe("App.java");
  });

  it("does not compact directories that also contain files or branch", () => {
    const tree = buildPathTree([change("a/b/x.ts"), change("a/y.ts")]);
    const a = tree[0] as ChangeTreeDir;
    expect(a.name).toBe("a");
    expect(a.children.map((c) => c.name)).toEqual(["b", "y.ts"]);
  });

  it("collects file paths under a node", () => {
    const tree = buildPathTree([change("src/a.ts"), change("src/sub/b.ts")]);
    expect(collectFilePaths(tree[0]).sort()).toEqual(["src/a.ts", "src/sub/b.ts"]);
  });
});
