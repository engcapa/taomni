import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectOnePath } from "../../../lib/ipc/files";
import { readDrawioFile } from "./drawioFile";
import { MarkdownDrawioImport } from "./MarkdownDrawioImport";

vi.mock("../../../lib/ipc/files", () => ({ selectOnePath: vi.fn() }));
vi.mock("../../../lib/runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("./drawioFile", () => ({ readDrawioFile: vi.fn() }));
vi.mock("../viewerLabels", () => ({ useViewerLabels: () => (_zh: string, en: string) => en }));
vi.mock("./drawioRender", async (original) => ({ ...await original<typeof import("./drawioRender")>(), renderDrawioPage: vi.fn(async () => ({ svg: "<svg/>", width: 100, height: 100, warnings: [], missingImages: 0 })) }));
const xml = '<mxfile><diagram name="Selected"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
function editor() {
  return { state: EditorState.create({ doc: "Original document" }), dispatch: vi.fn(), focus: vi.fn() };
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(readDrawioFile).mockResolvedValue(xml); });
afterEach(cleanup);

it("cancels the native chooser without inserting, then allows a fresh import", async () => {
  const owner = editor(), error = vi.fn();
  vi.mocked(selectOnePath).mockResolvedValueOnce(null).mockResolvedValueOnce("/selected.drawio");
  render(<MarkdownDrawioImport view={() => owner as unknown as EditorView} readOnly={false} onError={error} />);
  const button = screen.getByTestId("markdown-import-drawio");
  fireEvent.click(button);
  expect(button).toBeDisabled();
  await waitFor(() => expect(button).toBeEnabled());
  await waitFor(() => expect(button).toHaveFocus());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(readDrawioFile).not.toHaveBeenCalled(); expect(owner.dispatch).not.toHaveBeenCalled();
  fireEvent.click(button);
  await screen.findByTestId("markdown-drawio-import-dialog");
  expect(selectOnePath).toHaveBeenLastCalledWith(expect.objectContaining({ filters: [{ name: "draw.io", extensions: ["drawio", "xml"] }] }));
  fireEvent.click(screen.getByTestId("markdown-drawio-import-diagram"));
  await waitFor(() => expect(screen.getByTestId("markdown-drawio-import-confirm")).toBeEnabled());
  fireEvent.click(screen.getByTestId("markdown-drawio-import-confirm"));
  await waitFor(() => expect(owner.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ changes: expect.objectContaining({ insert: expect.stringContaining("```drawio") }) })));
  expect(error).not.toHaveBeenCalled();
});

it("discards a chooser result after its editor unmounts", async () => {
  const owner = editor();
  let choose!: (value: string) => void;
  vi.mocked(selectOnePath).mockReturnValue(new Promise((resolve) => { choose = resolve; }));
  const mounted = render(<MarkdownDrawioImport view={() => owner as unknown as EditorView} readOnly={false} onError={vi.fn()} />);
  fireEvent.click(screen.getByTestId("markdown-import-drawio"));
  mounted.unmount();
  await act(async () => choose("/late.drawio"));
  expect(readDrawioFile).not.toHaveBeenCalled(); expect(owner.dispatch).not.toHaveBeenCalled();
});

it("rejects inserting into a document changed while its native chooser was open", async () => {
  const owner = editor(), error = vi.fn();
  let choose!: (value: string) => void;
  vi.mocked(selectOnePath).mockReturnValue(new Promise((resolve) => { choose = resolve; }));
  render(<MarkdownDrawioImport view={() => owner as unknown as EditorView} readOnly={false} onError={error} />);
  fireEvent.click(screen.getByTestId("markdown-import-drawio"));
  owner.state = EditorState.create({ doc: "Changed document" });
  await act(async () => choose("/selected.drawio"));
  fireEvent.click(screen.getByTestId("markdown-drawio-import-diagram"));
  await waitFor(() => expect(screen.getByTestId("markdown-drawio-import-confirm")).toBeEnabled());
  fireEvent.click(screen.getByTestId("markdown-drawio-import-confirm"));
  expect(owner.dispatch).not.toHaveBeenCalled();
  await waitFor(() => expect(error).toHaveBeenCalledWith("Document changed; choose an import position again"));
});
