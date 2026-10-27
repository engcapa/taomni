import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef } from "../../../../types";
import { fileKey, makeLoadingFile } from "../codeWorkspaceModel";
import { getAllLeafNodes, validateTreeGroupConsistency } from "../recursiveLayoutTree";
import type { WorkspaceHostIntegration } from "../workspaceHostIntegration";
import { useWorkspaceHostCanvas } from "./useWorkspaceHostCanvas";

const instanceId = "canvas-regression";
const refs: CodeWorkspaceFileRef[] = ["a.txt", "b.txt", "c.txt", "d.txt"].map((path) => ({ kind: "root", rootId: "root", path }));
const keys = refs.map(fileKey);
const noop = () => undefined;
const ui = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId);

function host(layout: WorkspaceHostIntegration["canvasLayout"], count = 4, active = 0): WorkspaceHostIntegration {
  return {
    active: true, editorVisible: true, leftToolAreaVisible: true, showEditorTabs: false,
    navigationItems: [], files: refs.slice(0, count), activeFile: refs[active] ?? null,
    canvasLayout: layout, paneFiles: refs.slice(0, Math.min(count, layout === "single" ? 1 : layout === "split" ? 2 : 4)),
    leftToolAreaHost: null, onActivateFile: noop, onOpenGitDiff: noop, onActivateToolWindow: noop,
    onLeftToolAreaChange: noop, registerFileMenu: noop, onSnapshot: noop, recoverDraft: () => null,
  };
}

function expectPanes(expected: string[], active: string) {
  const current = ui();
  const leaves = getAllLeafNodes(current.layoutTreeV2);
  expect(leaves.map((leaf) => leaf.activeKey).sort()).toEqual([...expected].sort());
  expect(validateTreeGroupConsistency(current.layoutTreeV2, current.editorGroups)).toMatchObject({ consistent: true, errors: [] });
  expect(current.editorGroups[current.activeEditorGroupId].activeKey).toBe(active);
  expect(Object.values(current.editorGroups).flatMap((group) => group.openOrder)).toEqual(expect.arrayContaining(keys));
}

describe("workspace toolbar canvas uses the live editor layout", () => {
  beforeEach(() => {
    useCodeWorkspaceStore.setState({ byInstanceId: {} });
    const store = useCodeWorkspaceStore.getState();
    store.ensureInstance(instanceId);
    store.updateOpenFiles(instanceId, Object.fromEntries(refs.map((ref, index) => [fileKey(ref), {
      ...makeLoadingFile(ref, [], []), loading: false, text: `draft-${index}`, savedText: `saved-${index}`, dirty: true,
    }])));
    store.updateEditorGroup(instanceId, "primary", (group) => ({ ...group, openOrder: keys, activeKey: keys[0], pinnedKeys: [keys[0]] }));
  });
  afterEach(cleanup);

  it.each([2, 3, 4])("renders a %i-file grid with the requested active file", (count) => {
    const buffers = ui().openFiles;
    renderHook(() => useWorkspaceHostCanvas(host("grid", count), instanceId, true));
    expectPanes(keys.slice(0, count), keys[0]);
    expect(ui().openFiles).toBe(buffers);
    expect(Object.values(ui().editorGroups).flatMap((group) => group.pinnedKeys)).toContain(keys[0]);
  });

  it("supports repeated grid → split → grid → single transitions from the active secondary leaf", () => {
    const buffers = ui().openFiles;
    const { rerender } = renderHook(({ request }) => useWorkspaceHostCanvas(request, instanceId, true), { initialProps: { request: host("grid") } });
    expectPanes(keys, keys[0]);
    for (let iteration = 0; iteration < 3; iteration++) {
      const request = host("split", 4, 1);
      request.paneFiles = [refs[1], refs[0]];
      rerender({ request });
      expectPanes([keys[1], keys[0]], keys[1]);
      rerender({ request: host("grid") });
      expectPanes(keys, keys[0]);
    }
    rerender({ request: host("single") });
    expectPanes([keys[0]], keys[0]);
    expect(ui().openFiles).toBe(buffers);
  });

  it("retains an independent editor split in single mode and collapses only an explicit outer layout change", () => {
    const store = useCodeWorkspaceStore.getState();
    store.splitLayoutLeaf(instanceId, "primary", "vertical", keys[1]);
    const before = ui().layoutTreeV2;
    const { rerender } = renderHook(({ request }) => useWorkspaceHostCanvas(request, instanceId, true), { initialProps: { request: host("single") } });
    expect(ui().layoutTreeV2).toBe(before);
    rerender({ request: host("split") });
    expectPanes(keys.slice(0, 2), keys[0]);
    rerender({ request: host("single") });
    expectPanes([keys[0]], keys[0]);
  });

  it.each([0, 1])("does not create phantom editor panes for %i file(s)", (count) => {
    renderHook(() => useWorkspaceHostCanvas(host("grid", count), instanceId, true));
    expect(getAllLeafNodes(ui().layoutTreeV2)).toHaveLength(1);
    expect(validateTreeGroupConsistency(ui().layoutTreeV2, ui().editorGroups).consistent).toBe(true);
  });

  it("waits for file reconciliation and loading, then applies the current request", () => {
    const loading = { ...ui().openFiles[keys[3]], loading: true };
    useCodeWorkspaceStore.getState().updateOpenFiles(instanceId, (files) => ({ ...files, [keys[3]]: loading }));
    const before = ui().layoutTreeV2;
    const { rerender } = renderHook(({ ready, request }) => useWorkspaceHostCanvas(request, instanceId, ready), { initialProps: { ready: false, request: host("grid") } });
    expect(ui().layoutTreeV2).toBe(before);
    rerender({ ready: true, request: host("grid") });
    expect(ui().layoutTreeV2).toBe(before);
    act(() => useCodeWorkspaceStore.getState().updateOpenFiles(instanceId, (files) => ({ ...files, [keys[3]]: { ...loading, loading: false } })));
    rerender({ ready: true, request: host("grid") });
    expectPanes(keys, keys[0]);
  });

  it("does not replay identical layout requests under StrictMode or host identity changes", () => {
    const { rerender } = renderHook(({ request }) => useWorkspaceHostCanvas(request, instanceId, true), {
      initialProps: { request: host("grid") }, wrapper: StrictMode,
    });
    expectPanes(keys, keys[0]);
    const before = ui();
    rerender({ request: host("grid") });
    expect(ui()).toBe(before);
  });
});
