import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../types/workspace";
const backend = vi.hoisted(() => ({ records: [] as Workspace[], conflict: false }));
vi.mock("../lib/workspacePersistence", () => ({
  listWorkspaces: async () => structuredClone(backend.records),
  saveWorkspace: async (workspace: Workspace) => {
    const current = backend.records.find((w) => w.id === workspace.id);
    if (backend.conflict && current) { backend.conflict = false; current.description = "changed in another window"; current.revision++; }
    if ((current?.revision ?? 0) !== workspace.revision) throw new Error("workspace revision conflict");
    const saved = { ...structuredClone(workspace), revision: workspace.revision + 1 };
    backend.records = [...backend.records.filter((w) => w.id !== workspace.id), saved];
    return saved;
  },
  deleteWorkspace: async (workspace: Workspace) => { backend.records = backend.records.filter((w) => w.id !== workspace.id); },
}));
import { useWorkspaceStore } from "./workspaceStore";
beforeEach(() => {
  backend.records = []; backend.conflict = false;
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, hydrated: false, error: null, section: "work", canvas: "workspace" });
});
describe("workspace catalog", () => {
  it("does not flash an older surface while rapid selections and pane changes persist", async () => {
    const store = useWorkspaceStore.getState();
    const workspace = await store.create("Rapid navigation");
    store.selectView("files");
    store.selectView("preview");
    const observed: string[] = [];
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      observed.push(state.workspaces[0].navigation.activeSurface);
    });
    await store.patch(workspace.id, { navigation: { rightPaneOpen: true } });
    unsubscribe();
    expect(observed.every((view) => view === "preview")).toBe(true);
    expect(backend.records[0].navigation).toMatchObject({ activeSurface: "preview", rightPaneOpen: true });
  });
  it("serializes concurrent migrations and preserves the user's selection", async () => {
    const store = useWorkspaceStore.getState();
    const selected = await store.create("Selected");
    const recent = { id: "concurrent-root", name: "Legacy", roots: [], looseFiles: [], lastOpenedAt: 1, isGitRepo: false };
    const [first, second] = await Promise.all([
      store.create("Legacy", recent, false), store.create("Legacy", recent, false), store.load(),
    ]);
    expect(first.id).toBe(second.id);
    expect(backend.records).toHaveLength(2);
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(selected.id);
  });
  it("keeps a queued reload and deletion ordered with membership writes", async () => {
    const store = useWorkspaceStore.getState();
    const workspace = await store.create("Temporary");
    await Promise.all([store.addMembership(workspace.id, "shared"), store.load(), store.remove(workspace.id)]);
    expect(backend.records).toEqual([]);
    expect(useWorkspaceStore.getState().workspaces).toEqual([]);
  });
  it("shares canonical IDs without copying session config and removes only one reference", async () => {
    const store = useWorkspaceStore.getState();
    const a = await store.create("A"); const b = await store.create("B");
    await Promise.all([store.addMembership(a.id, "shared"), store.addMembership(b.id, "shared")]);
    await store.addMembership(a.id, "shared");
    expect(backend.records.find((w) => w.id === a.id)?.memberships).toHaveLength(1);
    await store.removeMembership(a.id, "shared");
    expect(backend.records.find((w) => w.id === b.id)?.memberships[0].sessionId).toBe("shared");
    await store.remove(a.id);
    expect(backend.records.map((w) => w.id)).toEqual([b.id]);
  });
  it("reapplies a rename over concurrent metadata without overwriting the other window", async () => {
    const store = useWorkspaceStore.getState();
    const workspace = await store.create("Initial");
    backend.conflict = true;
    await store.patch(workspace.id, { name: "Renamed" });
    expect(backend.records[0]).toMatchObject({ name: "Renamed", description: "changed in another window", revision: 3 });
  });
  it("migrates recent identity once and preserves durable identity after roots change", async () => {
    const store = useWorkspaceStore.getState();
    const recent = { id: "root-hash", name: "Legacy", roots: [], looseFiles: [], lastOpenedAt: 1, isGitRepo: false };
    const workspace = await store.create("Legacy", recent);
    expect((await store.create("Legacy", recent)).id).toBe(workspace.id);
    await store.patch(workspace.id, { name: "New", roots: [{ id: "root", path: "/new", name: "new", kind: "folder" }] });
    expect(backend.records).toHaveLength(1);
    expect(backend.records[0]).toMatchObject({ id: workspace.id, legacyRecentId: "root-hash" });
  });
  it("restores navigation but does not create sessions or discard unavailable references", async () => {
    const store = useWorkspaceStore.getState(); const workspace = await store.create("A");
    await store.addMembership(workspace.id, "missing");
    await store.patch(workspace.id, { navigation: { activeSurface: "tao", navigatorCollapsed: true, rightPaneOpen: false } });
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
    await store.load();
    expect(useWorkspaceStore.getState().workspaces[0]).toMatchObject({ navigation: { activeSurface: "tao" }, memberships: [{ sessionId: "missing" }] });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(workspace.id);
  });
});
