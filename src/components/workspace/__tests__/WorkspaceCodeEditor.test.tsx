import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceTabProps } from "../../editor/workspace/controller/model";
import { WorkspaceCodeEditor } from "../WorkspaceCodeEditor";
import { useAppStore } from "../../../stores/appStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useWorkspaceGitContextStore } from "../../../stores/workspaceGitContextStore";
import type { CodeWorkspaceContext } from "../../../stores/app/types";

const editor = vi.hoisted(() => ({ props: null as CodeWorkspaceTabProps | null }));
vi.mock("../../editor/CodeWorkspaceTab", () => ({
  CodeWorkspaceTab: (props: CodeWorkspaceTabProps) => { editor.props = props; return <div>Editor</div>; },
}));
const root = { id: "root", name: "project", path: "/project", kind: "folder" as const };
let workspaceId: string;
let tabId: string;
const context = (patch: Partial<CodeWorkspaceContext> = {}): CodeWorkspaceContext => ({
  repoRoot: root.path, roots: [root], looseFiles: [], activePath: null,
  openPaths: [], dirtyPaths: [], activeFile: null, openFiles: [], dirtyFiles: [], ...patch,
});
const current = () => useWorkspacePlatformStore.getState().getWorkspace(workspaceId)!;
function Harness() {
  const workspace = useWorkspacePlatformStore((state) => state.workspaces.find((item) => item.id === workspaceId)!);
  return <WorkspaceCodeEditor workspace={workspace} tabId={tabId} visible />;
}
beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ codeWorkspaceByTab: {}, recentWorkspaces: [] });
  useWorkspaceGitContextStore.setState({ byWorkspace: {} });
  const workspace = useWorkspacePlatformStore.getState().createWorkspace({ name: "project", codeWorkspace: {
    repoRoot: root.path, roots: [root], looseFiles: [], workspaceInstanceId: "recovery-owner",
    initialFile: { kind: "root", rootId: root.id, path: "notes.txt" },
  } });
  workspaceId = workspace.id;
  tabId = useWorkspacePlatformStore.getState().openCodeWorkspaceTab(workspaceId).id;
});
afterEach(cleanup);

describe("platform editor ownership", () => {
  it("retains the requested initial file until the editor publishes it, and then records a closed last file", async () => {
    render(<Harness />);
    act(() => useAppStore.getState().setTabCodeWorkspaceContext(tabId, context()));
    expect(current().codeWorkspace?.initialFile).toMatchObject({ path: "notes.txt" });
    act(() => useAppStore.getState().setTabCodeWorkspaceContext(tabId, context({
      activeFile: { kind: "root", rootId: root.id, path: "notes.txt" },
    })));
    await waitFor(() => expect(useAppStore.getState().recentWorkspaces[0]?.lastActiveFile).toMatchObject({ path: "notes.txt" }));
    act(() => useAppStore.getState().setTabCodeWorkspaceContext(tabId, context()));
    expect(current().codeWorkspace?.initialFile).toBeNull();
    expect(current().codeWorkspace?.workspaceInstanceId).toBe("recovery-owner");
  });

  it("does not overwrite a new sidebar project definition with a previous editor publication", () => {
    render(<Harness />);
    act(() => useAppStore.getState().setTabCodeWorkspaceContext(tabId, context()));
    const added = { id: "second", name: "second", path: "/second", kind: "folder" as const };
    act(() => useWorkspacePlatformStore.getState().addRootFolder(workspaceId, added));
    expect(editor.props?.workspace.roots?.map((item) => item.path)).toEqual(["/project", "/second"]);
    expect(current().rootFolders).toHaveLength(2);
    act(() => useAppStore.getState().setTabCodeWorkspaceContext(tabId, context({ roots: [root, added] })));
    expect(current().codeWorkspace?.roots).toHaveLength(2);
  });

  it("uses discovered nested Git repositories and the active repository, disposing the linked tab when roots disappear", () => {
    const view = render(<Harness />);
    const nested = { id: "git", name: "nested", path: "/project/nested", repoRoot: "/project/nested", rootIds: [root.id] };
    const payload = { workspaceName: "project", roots: [nested], activeRepoRoot: nested.repoRoot };
    act(() => editor.props?.onOpenGitManager?.(payload));
    expect(current().openTabs.some((tab) => tab.kind === "git")).toBe(true);
    expect(useWorkspaceGitContextStore.getState().byWorkspace[workspaceId]).toEqual({ roots: payload.roots, activeRepoRoot: payload.activeRepoRoot });
    act(() => editor.props?.onSyncGitManager?.({ ...payload, roots: [], activeRepoRoot: null }));
    expect(current().openTabs.some((tab) => tab.kind === "git")).toBe(false);
    view.unmount();
    expect(useWorkspaceGitContextStore.getState().byWorkspace[workspaceId]).toBeUndefined();
  });
});
