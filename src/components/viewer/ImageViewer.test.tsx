import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../lib/viewer";

const mocks = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn(), open: vi.fn(), system: vi.fn(), reveal: vi.fn(), save: vi.fn(), edit: vi.fn(), copy: vi.fn(), copyPath: vi.fn() }));
vi.mock("../../lib/viewer", () => ({ viewerReadBytes: mocks.read }));
vi.mock("../../lib/sftp", async () => {
  const paths = await import("../../lib/filePaths");
  return { ...paths, sftpListLocal: mocks.list, sftpOpenPath: mocks.system, effectiveFileType: (entry: { fileType: string }) => entry.fileType, formatBytes: (size: number) => `${size} B` };
});
vi.mock("../../lib/clipboard", () => ({ writeText: mocks.copyPath, writeImagePng: mocks.copy }));
vi.mock("../../lib/explorer/openExplorer", () => ({ openExplorer: mocks.reveal }));
vi.mock("../../lib/openFile", () => ({ openFile: mocks.open }));
vi.mock("../../stores/documentStore", () => ({ useDocumentStore: { getState: () => ({ save: mocks.save, edit: mocks.edit }) } }));
vi.mock("./ImageViewerExport", () => ({ saveImageCopy: vi.fn(async () => "/saved/copy.png") }));
vi.mock("./EditorSurface", () => ({ EditorSurface: ({ document }: { document: ViewerDocument }) => <textarea data-testid="viewer-editor-content" value={document.content} onChange={(event) => mocks.edit(document.path, event.target.value)} /> }));
vi.mock("./viewerLabels", () => ({ useViewerLabels: () => (_zh: string, en: string) => en }));
import { ImageViewer } from "./ImageViewer";

function doc(extra: Partial<ViewerDocument> = {}): ViewerDocument {
  return { key: "/images/logo.svg", path: "/images/logo.svg", kind: "svg", content: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>', savedContent: "", savedHash: "saved", encoding: "UTF-8", bom: false, eol: "LF", savedEncoding: "UTF-8", savedBom: false, savedEol: "LF", originalLineEndings: [], dirty: false, mtime: 1, size: 128, readOnly: false, loading: false, saving: false, large: false, truncated: false, revision: 0, chunkOffset: 0, nextOffset: 128, eof: true, ...extra };
}
const entry = (name: string) => ({ name, path: `/images/${name}`, size: 128, mtime: 1, fileType: "file", isHidden: false, mode: 0 });
function decoded() {
  const image = screen.getByTestId("image-render");
  Object.defineProperty(image, "naturalWidth", { value: 200, configurable: true });
  Object.defineProperty(image, "naturalHeight", { value: 100, configurable: true });
  fireEvent.load(image);
  return image;
}

beforeEach(() => {
  vi.clearAllMocks();
  let index = 0;
  URL.createObjectURL = vi.fn(() => `blob:viewer-${++index}`);
  URL.revokeObjectURL = vi.fn();
  mocks.read.mockResolvedValue({ bytes: [1, 2, 3], mime: "image/png", size: 3 });
  mocks.list.mockResolvedValue([entry("logo.svg"), entry("next.png")]);
  mocks.open.mockResolvedValue(undefined); mocks.save.mockResolvedValue(undefined);
  // These renderer tests intentionally do not decode neighbouring images or launch any UI.
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("image and SVG renderer", () => {
  it("defaults SVG to editable split, sanitizes only rendering, and preserves modes", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" onload="alert(1)"><script>alert(1)</script><rect width="200" height="100"/></svg>';
    render(<ImageViewer document={doc({ content: source, dirty: true })} onError={vi.fn()} />);
    await screen.findByTestId("image-render");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(screen.getByTestId("image-svg-mode-split")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("viewer-editor-content")).toHaveValue(source);
    expect(screen.getByTestId("image-sanitized")).toHaveTextContent("Sanitized");
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    const clean = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
    expect(clean).not.toMatch(/script|onload/);
    fireEvent.change(screen.getByTestId("viewer-editor-content"), { target: { value: source + "\n" } });
    expect(mocks.edit).toHaveBeenCalledWith("/images/logo.svg", source + "\n");
    fireEvent.click(screen.getByTestId("image-save"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("/images/logo.svg"));
    fireEvent.click(screen.getByTestId("image-svg-mode-code"));
    expect(screen.getByTestId("image-stage")).toHaveAttribute("hidden");
    fireEvent.click(screen.getByTestId("image-svg-mode-render"));
    expect(screen.getByTestId("image-stage")).not.toHaveAttribute("hidden");
  });

  it("zooms, fits, rotates, flips and changes background without writing the image", async () => {
    render(<ImageViewer document={doc()} onError={vi.fn()} />);
    await screen.findByTestId("image-render");
    const image = decoded();
    fireEvent.click(screen.getByTestId("image-zoom-in"));
    expect(image.style.transform).toContain("scale(1.2)");
    fireEvent.click(screen.getByTestId("image-rotate-right"));
    fireEvent.click(screen.getByTestId("image-flip"));
    expect(image.style.transform).toContain("rotate(90deg) scaleX(-1)");
    fireEvent.click(screen.getByTestId("image-background-dark"));
    expect(screen.getByTestId("image-stage")).toHaveClass("image-background-dark");
    fireEvent.click(screen.getByTestId("image-zoom-actual"));
    expect(screen.getByTestId("image-zoom-actual")).toHaveTextContent("100%");
    fireEvent.click(screen.getByTestId("image-zoom-fit"));
    expect(screen.getByTestId("image-zoom-actual")).toHaveTextContent("Fit");
    fireEvent.wheel(screen.getByTestId("image-stage"), { deltaY: -100 });
    expect(screen.getByTestId("image-zoom-actual")).not.toHaveTextContent("Fit");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it("uses openFile for sibling navigation, not direct system opens", async () => {
    render(<ImageViewer document={doc()} onError={vi.fn()} />);
    await screen.findByTestId("image-render");
    decoded();
    await waitFor(() => expect(screen.getByTestId("image-next")).toBeEnabled());
    fireEvent.click(screen.getByTestId("image-next"));
    expect(mocks.open).toHaveBeenCalledWith({ path: "/images/next.png" }, { context: "viewer" });
    fireEvent.keyDown(screen.getByTestId("image-stage"), { key: "ArrowRight", isComposing: true });
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.system).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("image-copy-path"));
    await waitFor(() => expect(mocks.copyPath).toHaveBeenCalledWith("/images/logo.svg"));
  });

  it("keeps image navigation in its workspace and never enumerates remote read-only temp siblings", async () => {
    const { rerender } = render(<ImageViewer document={doc()} onError={vi.fn()} workspaceId="workspace-1" />);
    await screen.findByTestId("image-render"); decoded();
    await waitFor(() => expect(screen.getByTestId("image-next")).toBeEnabled());
    fireEvent.click(screen.getByTestId("image-next"));
    expect(mocks.open).toHaveBeenCalledWith({ path: "/images/next.png" }, { context: "viewer", workspaceId: "workspace-1" });
    mocks.list.mockClear(); mocks.open.mockClear();
    rerender(<ImageViewer document={doc({ key: "temp", readOnly: true, readOnlyReason: "Remote temporary copy" })} onError={vi.fn()} workspaceId="workspace-1" />);
    await screen.findByTestId("image-render"); decoded();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(screen.getByTestId("image-next")).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId("image-stage"), { key: "ArrowRight" });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("shows the explicit conservative 32 MiB file cap before reading bytes", async () => {
    render(<ImageViewer document={doc({ key: "large", path: "/images/large.png", kind: "image", size: 32 * 1024 * 1024 + 1 })} onError={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("conservative 32 MiB file cap");
    expect(screen.getByRole("alert")).toHaveTextContent("not yet native performance-measured");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("drops stale raster reads and releases owned blob URLs on content changes/unmount", async () => {
    let resolve!: (value: { bytes: number[]; mime: string; size: number }) => void;
    mocks.read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { rerender, unmount } = render(<ImageViewer document={doc({ key: "one", path: "/images/one.png", kind: "image" })} onError={vi.fn()} />);
    rerender(<ImageViewer document={doc()} onError={vi.fn()} />);
    await screen.findByTestId("image-render");
    await act(async () => resolve({ bytes: [9], mime: "image/png", size: 1 }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const url = screen.getByTestId("image-render").getAttribute("src");
    rerender(<ImageViewer document={doc({ content: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>' })} onError={vi.fn()} />);
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith(url));
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
