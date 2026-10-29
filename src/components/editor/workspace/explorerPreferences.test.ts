import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceEntry } from "../../../lib/editor/workspace";
import { createExplorerNameCollator, DEFAULT_EXPLORER_SORT, EXPLORER_SORT_KEY, explorerPackage, readExplorerSort, sortExplorerEntries, writeExplorerSort } from "./explorerPreferences";

const entry = (name: string, size: number, mtime: number, fileType: WorkspaceEntry["fileType"] = "file"): WorkspaceEntry =>
  ({ name, path: name, size, mtime, fileType, isHidden: false });
const files = [entry("notes10.txt", 20, 3), entry("Documents", 0, 1, "dir"), entry("notes2.txt", 100, 2), entry("budget.csv", 50, 4)];

describe("file explorer preferences", () => {
  beforeEach(() => localStorage.clear());

  it.each(["en-US-u-va-posix", "en-US", "zh-CN"])("sorts mixed case and numeric names naturally with %s", (locale) => {
    const names = ["README.md", "Draft10.txt", "document-0299.txt", "Draft2.txt", "document-0000.txt"];
    expect(names.sort(createExplorerNameCollator(locale).compare))
      .toEqual(["document-0000.txt", "document-0299.txt", "Draft2.txt", "Draft10.txt", "README.md"]);
  });

  it("naturally sorts names, retains folders first in both directions and never mutates a listing", () => {
    expect(sortExplorerEntries(files, DEFAULT_EXPLORER_SORT).map((file) => file.name))
      .toEqual(["Documents", "budget.csv", "notes2.txt", "notes10.txt"]);
    expect(sortExplorerEntries(files, { ...DEFAULT_EXPLORER_SORT, descending: true }).map((file) => file.name))
      .toEqual(["Documents", "notes10.txt", "notes2.txt", "budget.csv"]);
    expect(files[0].name).toBe("notes10.txt");
  });

  it.each([
    ["size", ["Documents", "notes10.txt", "budget.csv", "notes2.txt"]],
    ["modified", ["Documents", "notes2.txt", "notes10.txt", "budget.csv"]],
    ["type", ["Documents", "budget.csv", "notes2.txt", "notes10.txt"]],
  ] as const)("sorts %s with deterministic name ties", (field, names) => {
    expect(sortExplorerEntries(files, { ...DEFAULT_EXPLORER_SORT, field }).map((file) => file.name)).toEqual(names);
  });

  it("persists sort settings and safely handles old or damaged preferences", () => {
    const sort = { field: "modified" as const, descending: true, foldersFirst: false };
    writeExplorerSort(sort);
    expect(readExplorerSort()).toEqual(sort);
    localStorage.setItem(EXPLORER_SORT_KEY, '{"field":"unknown"}');
    expect(readExplorerSort()).toEqual(DEFAULT_EXPLORER_SORT);
    localStorage.setItem(EXPLORER_SORT_KEY, "broken");
    expect(readExplorerSort()).toEqual(DEFAULT_EXPLORER_SORT);
    expect(sortExplorerEntries(files, { ...sort, field: "name" }).at(-1)?.name).toBe("budget.csv");
  });

  it("orders grouped folders by name rather than platform-specific directory metadata", () => {
    const entries = [entry("Pictures", 4096, 9, "dir"), entry("Documents", 512, 3, "dir"), entry("src", 32, 1, "dir")];
    expect(sortExplorerEntries(entries, { ...DEFAULT_EXPLORER_SORT, field: "size" }).map((file) => file.name))
      .toEqual(["Documents", "Pictures", "src"]);
    expect(sortExplorerEntries(entries, { ...DEFAULT_EXPLORER_SORT, field: "modified", descending: true }).map((file) => file.name))
      .toEqual(["src", "Pictures", "Documents"]);
  });

  it("keeps packages with the same name in different source sets separate, including Windows paths", () => {
    expect(explorerPackage("src/main/java/com/example/App.java"))
      .toEqual({ sourceRoot: "src/main/java", name: "com.example", file: "App.java" });
    expect(explorerPackage("src/test/java/com/example/AppTest.java").sourceRoot).toBe("src/test/java");
    expect(explorerPackage("module\\src\\main\\kotlin\\org\\demo\\App.kt"))
      .toEqual({ sourceRoot: "module/src/main/kotlin", name: "org.demo", file: "App.kt" });
    expect(explorerPackage("src/components/workspace/View.tsx").name).toBe("components.workspace");
  });
});
