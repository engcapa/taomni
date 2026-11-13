import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectExplorerMenu } from "./projectExplorerMenu";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import { workspaceEditorInstanceId } from "../workspaceRuntimeIdentity";

const mocks = vi.hoisted(() => ({ open: vi.fn(async () => "tab") }));
vi.mock("./openExplorer", () => ({ openExplorer: mocks.open }));
beforeEach(() => { localStorage.clear(); useWorkspacePlatformStore.getState().reloadFromStorage(); vi.clearAllMocks(); });

describe("project tree Explorer commands", () => {
  it("keeps the owner workspace captured when a menu is built and supports new tabs", async () => {
    const store = useWorkspacePlatformStore.getState();
    const owner = store.createWorkspace({ name: "Owner", rootPath: "/owner" });
    const roots = owner.rootFolders.map((root) => ({ ...root, kind: "folder" as const }));
    const menu = projectExplorerMenu(workspaceEditorInstanceId(owner), roots, roots[0].id, "nested");
    store.createWorkspace({ name: "Other", rootPath: "/other" });
    menu[0].onClick?.();
    menu[1].onClick?.();
    expect(mocks.open).toHaveBeenNthCalledWith(1, "/owner/nested", { workspaceId: owner.id, forceNew: false });
    expect(mocks.open).toHaveBeenNthCalledWith(2, "/owner/nested", { workspaceId: owner.id, forceNew: true });
  });
  it("does not expose an invalid root path", () => {
    expect(projectExplorerMenu("unknown", [], "absent", "")).toEqual([]);
  });
});
