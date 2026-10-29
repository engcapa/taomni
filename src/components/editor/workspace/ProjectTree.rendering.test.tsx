import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../lib/i18n";
import { ProjectTree, type ProjectTreeProps } from "./ProjectTree";
import { fileKey, rootDirKey } from "./codeWorkspaceModel";

const icons = vi.hoisted(() => vi.fn());
vi.mock("./WorkspaceFileIcon", () => ({
  WorkspaceFileIcon: (props: { path: string }) => { icons(props.path); return null; },
}));
vi.mock("./treeToolbarChrome", async (original) => ({
  ...await original<typeof import("./treeToolbarChrome")>(),
  treeModifiedDate: (mtime: number, locale: string) => `${locale}:${mtime}`,
}));

function fixture(): ProjectTreeProps {
  return {
    roots: [{ id: "root", name: "fixture", path: "/fixture", kind: "folder" }],
    looseFiles: [], compactChains: {}, flatFiles: {},
    directories: { [rootDirKey("root", "")]: {
      entries: ["a.txt", "b.json", "src"].map((path) => ({
        name: path, path, fileType: path === "src" ? "dir" : "file", size: 12, mtime: 1, isHidden: false,
      })), loaded: true, loading: false, error: null,
    } },
    treeViewMode: "tree", treeFilter: "", expandedRoots: new Set(["root"]), expandedDirs: new Set(),
    selected: null, activeKey: null, openFiles: {}, gitChangeByRootPath: new Map(),
    onToggleRoot: vi.fn(), onToggleDir: vi.fn(), onSelect: vi.fn(), onOpenFile: vi.fn(), onContextMenu: vi.fn(),
  };
}
const ref = (path: string) => ({ kind: "root" as const, rootId: "root", path });
const row = (path: string) => screen.getAllByRole("treeitem").find((node) => node.getAttribute("data-path") === path)!;

describe("Project tree row updates", () => {
  afterEach(() => { cleanup(); icons.mockClear(); });

  it("updates the selected/active/dirty file without rebuilding unchanged visible rows", () => {
    const props = fixture();
    const { rerender } = render(<ProjectTree {...props} />);
    icons.mockClear();
    const selected = { kind: "file" as const, ref: ref("a.txt") };
    rerender(<ProjectTree {...props} selected={selected} activeKey={fileKey(selected.ref)} />);
    expect(row("a.txt")).toHaveAttribute("data-selected", "true");
    expect(row("a.txt")).toHaveAttribute("data-active", "true");
    expect(icons.mock.calls.map(([path]) => path).filter((path) => path !== "/fixture")).toEqual(["a.txt"]);
    icons.mockClear();
    rerender(<ProjectTree {...props} selected={selected} activeKey={fileKey(selected.ref)}
      openFiles={{ [fileKey(selected.ref)]: { dirty: true } }} />);
    expect(row("a.txt")).toHaveTextContent("*");
    expect(row("b.json")).not.toHaveTextContent("*");
    expect(icons.mock.calls.map(([path]) => path).filter((path) => path !== "/fixture")).toEqual(["a.txt"]);
    rerender(<ProjectTree {...props} selected={{ kind: "file", ref: ref("b.json") }} activeKey={fileKey(ref("b.json"))} />);
    expect(row("a.txt")).not.toHaveAttribute("data-active");
    expect(row("a.txt")).not.toHaveTextContent("*");
    expect(row("b.json")).toHaveAttribute("data-active", "true");
  });

  it("uses replacement handlers and current compact paths for open, select, toggle and context menus", () => {
    const props = fixture();
    const { rerender } = render(<ProjectTree {...props} />);
    const onOpenFile = vi.fn(), onSelect = vi.fn(), onToggleDir = vi.fn(), onContextMenu = vi.fn();
    rerender(<ProjectTree {...props} treeViewMode="compact"
      compactChains={{ [rootDirKey("root", "src")]: { path: "src/main", entries: [], loading: true, error: null } }}
      onOpenFile={onOpenFile} onSelect={onSelect} onToggleDir={onToggleDir} onContextMenu={onContextMenu} />);
    fireEvent.doubleClick(row("a.txt"));
    expect(onOpenFile).toHaveBeenCalledWith(ref("a.txt"), { preview: false });
    expect(onSelect).toHaveBeenCalledWith({ kind: "file", ref: ref("a.txt") });
    fireEvent.doubleClick(row("src/main"));
    expect(onToggleDir).toHaveBeenCalledWith("root", "src/main");
    fireEvent.contextMenu(row("src/main"));
    expect(onContextMenu).toHaveBeenCalledWith(expect.anything(), { kind: "dir", rootId: "root", path: "src/main" });
    expect(props.onOpenFile).not.toHaveBeenCalled();
    expect(props.onToggleDir).not.toHaveBeenCalled();
  });

  it("refreshes list metadata after a locale change while row inputs are stable", () => {
    const original = getLocale();
    act(() => setLocale("en"));
    try {
      render(<ProjectTree {...fixture()} treeViewMode="list" />);
      expect(row("a.txt")).toHaveTextContent("en:1");
      act(() => setLocale("zh-CN"));
      expect(row("a.txt")).toHaveTextContent("zh-CN:1");
      expect(row("src")).toHaveTextContent("zh-CN:1");
    } finally { act(() => setLocale(original)); }
  });
});
