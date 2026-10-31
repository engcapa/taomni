import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { expect, it, vi } from "vitest";
import { WorkspaceActionHost } from "./workspaceActionHost";
import { useMarkdownPreviewSearch } from "./useMarkdownPreviewSearch";
import { createKeymapScheme, setActionBindings } from "./workspaceKeymapScheme";

function Preview({ host }: { host: WorkspaceActionHost }) {
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const search = useMarkdownPreviewSearch(root, content, "Preview needle", {
    actionHost: host, groupId: "primary", standalone: false,
  });
  return <div ref={root} tabIndex={-1} data-testid="preview"
    onFocusCapture={search.onFocusCapture} onBlurCapture={search.onBlurCapture}>
    {search.toolbar}<div ref={content}>Preview needle</div>
  </div>;
}

it("keeps focused split preview Find when the source editor finishes mounting later", async () => {
  const host = new WorkspaceActionHost({ workspaceId: "preview-late-editor",
    getDefaultContext: () => ({ focus: "editor", hasActiveFile: true, editorViewId: "primary" }),
  });
  const sourceFind = vi.fn(() => ({ kind: "applied" as const }));
  render(<><Preview host={host} /><button>Source</button></>);
  act(() => screen.getByTestId("preview").focus());
  // CodeMirror loads asynchronously. Its registration can arrive after the
  // user has already clicked the mounted preview in Split mode.
  let disposeSource = () => {};
  act(() => {
    disposeSource = host.registerActions([{
      id: "editor.find", title: "Find", category: "Edit", provenance: "local",
      run: sourceFind,
    }], { ownerViewId: "primary" });
  });
  host.setKeymapScheme(setActionBindings(createKeymapScheme({ id: "preview-custom", name: "Custom", base: "idea-windows-linux" }), "editor.find", [{
    kind: "keyboard", strokes: [{ code: "KeyG", key: "g", ctrl: true, alt: true, shift: false, meta: false }],
  }]));
  expect(host.prepareBinding(new KeyboardEvent("keydown", { code: "KeyF", key: "f", ctrlKey: true })).resolution).toBe("none");
  await act(async () => {
    await host.dispatchKeydown(new KeyboardEvent("keydown", { code: "KeyG", key: "g", ctrlKey: true, altKey: true }));
  });
  const query = await screen.findByRole("searchbox", { name: "Find in preview" });
  await waitFor(() => expect(query).toHaveFocus());
  expect(sourceFind).not.toHaveBeenCalled();
  fireEvent.change(query, { target: { value: "needle" } });
  expect(screen.getByTestId("markdown-search-count")).toHaveTextContent("1/1");
  fireEvent.keyDown(query, { key: "Escape" });
  expect(screen.getByTestId("preview")).toHaveFocus();
  act(() => screen.getByRole("button", { name: "Source" }).focus());
  await act(async () => { await host.execute("editor.find"); });
  expect(sourceFind).toHaveBeenCalledOnce();
  act(() => disposeSource());
  host.dispose();
});
