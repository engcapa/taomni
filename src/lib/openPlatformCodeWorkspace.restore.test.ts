import { beforeEach, describe, expect, it } from "vitest";
import { createSingleLeafLayout } from "../components/editor/workspace/recursiveLayoutTree";
import {
  defaultWorkspaceLayoutSnapshot,
  readWorkspaceLayoutSnapshot,
  writeWorkspaceLayoutSnapshot,
} from "../components/editor/workspace/workspaceLayoutPersistence";
import { useAppStore } from "../stores/appStore";
import { useWorkspacePlatformStore } from "../stores/workspacePlatformStore";
import type { CodeWorkspaceTabInfo } from "../types";
import { openPlatformCodeWorkspace } from "./openPlatformCodeWorkspace";

const instanceId = "legacy-split-restore";
const paths = Array.from({ length: 24 }, (_, index) => `file${String(index).padStart(2, "0")}.txt`);
const keys = paths.map((path) => `root:root-a:${path}`);
const project: CodeWorkspaceTabInfo = {
  repoRoot: "/project", name: "Restored project", workspaceInstanceId: instanceId,
  roots: [{ id: "root-a", name: "project", path: "/project", kind: "folder" }],
  looseFiles: [{ id: "notes", name: "notes.txt", path: "/notes.txt" }],
  initialFile: { kind: "root", rootId: "root-a", path: paths[0] },
};

function seedLayout(primary = keys.slice(0, 12), secondary = keys.slice(12)) {
  const group = (openOrder: string[]) => ({ openOrder, activeKey: openOrder[0] ?? null, previewKey: null, pinnedKeys: [] });
  writeWorkspaceLayoutSnapshot(instanceId, {
    ...defaultWorkspaceLayoutSnapshot(), splitOrientation: "vertical",
    layoutTreeV2: {
      type: "split", id: "split-root", orientation: "vertical", ratios: [0.5, 0.5],
      children: [createSingleLeafLayout("primary", primary, primary[0] ?? null),
        createSingleLeafLayout("secondary", secondary, secondary[0] ?? null)],
    },
    editorGroups: { primary: group(primary), secondary: group(secondary) },
  });
}

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ activeSideTab: "home", tabs: [], activeTabId: "welcome" });
});

describe("legacy editor layout import", () => {
  it("registers all 24 restored split tabs with the host before its first reconciliation", () => {
    seedLayout();
    const before = readWorkspaceLayoutSnapshot(instanceId);
    const id = openPlatformCodeWorkspace(project);
    const workspace = useWorkspacePlatformStore.getState().getWorkspace(id)!;
    expect(workspace.openTabs.filter((tab) => tab.kind === "file").map((tab) => tab.filePath)).toEqual(paths);
    expect(workspace.openTabs.find((tab) => tab.id === workspace.activeTabId)?.filePath).toBe(paths[0]);
    expect(workspace.codeWorkspace?.workspaceInstanceId).toBe(instanceId);
    expect(readWorkspaceLayoutSnapshot(instanceId)).toEqual(before);
  });

  it("keeps loose and library tabs in the editor while importing only known roots once", () => {
    seedLayout([keys[0], "loose:notes", "library:java:List", "root:removed:gone.txt"], [keys[0], keys[12]]);
    const id = openPlatformCodeWorkspace(project);
    const workspace = useWorkspacePlatformStore.getState().getWorkspace(id)!;
    expect(workspace.openTabs.filter((tab) => tab.kind === "file").map((tab) => [tab.rootFolderId, tab.filePath]))
      .toEqual([["root-a", paths[0]], ["root-a", paths[12]]]);
    expect(readWorkspaceLayoutSnapshot(instanceId)?.editorGroups.primary.openOrder).toContain("loose:notes");
  });

  it("preserves the existing 24-tab limit per leaf when both leaves are full", () => {
    const remaining = Array.from({ length: 24 }, (_, index) => `file${index + 24}.txt`);
    seedLayout(keys, remaining.map((path) => `root:root-a:${path}`));
    const id = openPlatformCodeWorkspace(project);
    const workspace = useWorkspacePlatformStore.getState().getWorkspace(id)!;
    expect(workspace.openTabs.filter((tab) => tab.kind === "file").map((tab) => tab.filePath))
      .toEqual([...paths, ...remaining]);
  });

  it("does not resurrect a closed outer tab from a layout left behind by an interrupted save", () => {
    seedLayout();
    const id = openPlatformCodeWorkspace(project);
    const store = useWorkspacePlatformStore.getState();
    const closed = store.getWorkspace(id)!.openTabs.find((tab) => tab.filePath === paths[23]);
    expect(closed).toBeDefined();
    store.closeWorkspaceTab(id, closed!.id);
    window.dispatchEvent(new Event("pagehide"));
    store.reloadFromStorage();
    expect(openPlatformCodeWorkspace(project)).toBe(id);
    expect(store.getWorkspace(id)!.openTabs.filter((tab) => tab.kind === "file").map((tab) => tab.filePath))
      .toEqual(paths.slice(0, 23));
    expect(readWorkspaceLayoutSnapshot(instanceId)?.editorGroups.secondary.openOrder).toContain(keys[23]);
  });
});
