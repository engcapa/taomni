import { describe, expect, it } from "vitest";
import { fuzzyScore, nameInitials, rankFuzzy } from "./fuzzyMatch";

describe("nameInitials", () => {
  it("collects camelCase, separator, and digit boundaries", () => {
    expect(nameInitials("CodeWorkspaceTab.tsx")).toBe("cwtt");
    expect(nameInitials("find_in_files-panel.ts")).toBe("fifpt");
    expect(nameInitials("mod2rs")).toBe("m2");
  });
});

describe("fuzzyScore", () => {
  it("ranks exact > prefix > initials > name substring > path substring > subsequence", () => {
    const path = "src/components/editor/CodeWorkspaceTab.tsx";
    const exact = fuzzyScore("codeworkspacetab.tsx", path);
    const prefix = fuzzyScore("codework", path);
    const initials = fuzzyScore("cwt", path);
    const nameSub = fuzzyScore("workspacetab", path);
    const pathSub = fuzzyScore("components/editor", path);
    const subsequence = fuzzyScore("scet", path);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(initials);
    expect(initials).toBeGreaterThan(nameSub);
    expect(nameSub).toBeGreaterThan(pathSub);
    expect(pathSub).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
  });

  it("returns 0 for non-matches and a positive score for empty queries", () => {
    expect(fuzzyScore("zzz9", "src/a.ts")).toBe(0);
    expect(fuzzyScore("", "src/a.ts")).toBeGreaterThan(0);
  });
});

describe("rankFuzzy", () => {
  const paths = [
    "src/components/editor/CodeWorkspaceTab.tsx",
    "src/components/git/ChangesTree.tsx",
    "src/lib/editor/workspace.ts",
    "src/lib/codeViewProfile.ts",
  ];

  it("puts camelCase abbreviation hits first and drops non-matches", () => {
    const ranked = rankFuzzy("cwt", paths, (path) => path, 10);
    expect(ranked[0]).toBe("src/components/editor/CodeWorkspaceTab.tsx");
    expect(ranked).not.toContain("src/components/git/ChangesTree.tsx");
  });

  it("prefers shorter paths on ties and respects the limit", () => {
    const ranked = rankFuzzy("util", [
      "src/really/long/nested/util.ts",
      "src/a/util.ts",
    ], (path) => path, 1);
    expect(ranked).toEqual(["src/a/util.ts"]);
  });
});
