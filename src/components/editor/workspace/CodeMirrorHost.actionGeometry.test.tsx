import { act, cleanup, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { renderEditor } from "./tests/codeMirrorHost/harness";
import { WorkspaceActionHost } from "./workspaceActionHost";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mountActions() {
  const host = new WorkspaceActionHost({
    workspaceId: "geometry",
    getDefaultFocus: () => "editor",
    getDefaultContext: () => ({ hasActiveFile: true }),
  });
  const rendered = renderEditor("first\nsecond", vi.fn(), {
    fileKey: "a", path: "a.txt", viewId: "primary", workspaceActionHost: host,
  });
  const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
  const height = vi.fn(() => 200);
  Object.defineProperty(view.scrollDOM, "clientHeight", { get: height, configurable: true });
  vi.spyOn(view, "defaultLineHeight", "get").mockReturnValue(20);
  // jsdom has no viewport. Keep CodeMirror's resize measurement active.
  vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 200));
  vi.spyOn(view, "inView", "get").mockReturnValue(true);
  return { host, view, height, ...rendered };
}

it("projects editor action snapshots without forcing layout before the first measurement", () => {
  const { host, height } = mountActions();
  const pages = host.getSnapshot().filter((action) => /editor\.(selectP|p)age/.test(action.id));
  expect(pages).toHaveLength(4);
  expect(height).not.toHaveBeenCalled();
  expect(pages.every((action) => action.state.availability === "disabled")).toBe(true);
  expect(host.getState("editor.pageDown").disabledReason).toBe("geometryUnavailable");
  expect(height).not.toHaveBeenCalled();
});

it("publishes measured geometry, refreshes it on resize, and keeps snapshots free of DOM reads", async () => {
  const { host, view, height } = mountActions();
  await waitFor(() => expect(host.getState("editor.pageDown").availability).toBe("available"));
  height.mockClear();
  host.getSnapshot();
  expect(height).not.toHaveBeenCalled();
  vi.mocked(Object.getOwnPropertyDescriptor(view, "inView")!.get!).mockReturnValue(false);
  expect(host.getState("editor.pageDown").availability).toBe("disabled");
  vi.mocked(Object.getOwnPropertyDescriptor(view, "inView")!.get!).mockReturnValue(true);
  // Request the same measurement path CodeMirror uses after a viewport resize.
  height.mockReturnValue(0);
  act(() => { window.dispatchEvent(new Event("resize")); });
  await waitFor(() => expect(host.getState("editor.pageDown").availability).toBe("disabled"));
  height.mockReturnValue(300);
  act(() => { window.dispatchEvent(new Event("resize")); });
  await waitFor(() => expect(host.getState("editor.selectPageDown").availability).toBe("available"));
  height.mockClear();
  host.getSnapshot();
  expect(height).not.toHaveBeenCalled();
  expect(view.state.doc.toString()).toBe("first\nsecond");
});

it("requires a new measurement when the retained EditorView changes documents and releases actions on close", async () => {
  const { host, view, height, props, rerender, unmount } = mountActions();
  await waitFor(() => expect(host.getState("editor.pageDown").availability).toBe("available"));
  rerender(<CodeMirrorHost {...props} fileKey="b" path="b.txt" doc="other" />);
  expect(EditorView.findFromDOM(view.dom)).toBe(view);
  height.mockClear();
  expect(host.getState("editor.pageDown").availability).toBe("disabled");
  expect(height).not.toHaveBeenCalled();
  await waitFor(() => expect(host.getState("editor.pageDown").availability).toBe("available"));
  unmount();
  expect(host.getSnapshot().some((action) => action.id === "editor.pageDown")).toBe(false);
});
