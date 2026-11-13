import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  explorerCancelOperation,
  explorerReadPreviewBytes,
  explorerReadPreviewText,
  localProperties,
  type LocalProperties,
  type PreviewBytes,
  type PreviewText,
} from "../../../lib/explorer";
import { writeText } from "../../../lib/clipboard";
import { setLocale } from "../../../lib/i18n";
import { sftpListLocalDetailed, sftpOpenPath, type FileEntry } from "../../../lib/sftp";
import { getExplorerPreferences, setExplorerPreferences } from "../explorerPreferences";
import { ExplorerPreviewPane, type ExplorerPreviewPaneProps } from "./ExplorerPreviewPane";

vi.mock("../../../lib/explorer", () => ({
  explorerCancelOperation: vi.fn(),
  explorerReadPreviewBytes: vi.fn(),
  explorerReadPreviewText: vi.fn(),
  localProperties: vi.fn(),
}));
vi.mock("../../../lib/clipboard", () => ({ writeText: vi.fn() }));
vi.mock("../../../lib/sftp", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/sftp")>(),
  sftpListLocalDetailed: vi.fn(),
  sftpOpenPath: vi.fn(),
}));

function file(name: string, extra: Partial<FileEntry> = {}): FileEntry {
  return { name, path: `/fixture/${name}`, size: 10, mtime: 1, mode: 0o644, fileType: "file", isHidden: false, ...extra };
}
function metadata(path = "/fixture/folder", extra: Partial<LocalProperties> = {}): LocalProperties {
  return { path, name: "folder", size: 40, itemCount: 4, fileType: "dir", mtime: 1, createdAt: 1, mode: 0o755, owner: null, group: null, symlinkTarget: null, truncated: false, ...extra };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function props(entries: FileEntry[] = [file("notes.txt")]): ExplorerPreviewPaneProps {
  return { entries, currentPath: "/fixture", tabId: "preview-tab", onOpen: vi.fn(), onClose: vi.fn() };
}

const createObjectUrl = vi.fn(() => "blob:preview-image");
const revokeObjectUrl = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  setExplorerPreferences({ preview: true, previewPosition: "right", previewWidth: 300, wrap: false });
  vi.mocked(explorerReadPreviewText).mockResolvedValue({ text: "first line\nsecond line", truncated: false, binary: false });
  vi.mocked(explorerReadPreviewBytes).mockResolvedValue({ bytes: [137, 80, 78, 71], mime: "image/png" });
  vi.mocked(localProperties).mockImplementation(async (path) => metadata(path));
  vi.mocked(sftpListLocalDetailed).mockResolvedValue({ entries: [file("child.txt")], skippedCount: 0, diagnostics: [] });
  vi.mocked(explorerCancelOperation).mockResolvedValue(undefined);
  vi.mocked(writeText).mockResolvedValue(undefined);
  vi.mocked(sftpOpenPath).mockResolvedValue(undefined);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("data-testid") === "explorer-preview-text" ? 300 : 17;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(276);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Explorer preview content", () => {
  it("shows bounded text with line count, truncation notice and usable open actions", async () => {
    vi.mocked(explorerReadPreviewText).mockResolvedValue({ text: "first\nsecond", truncated: true, binary: false });
    const input = props([file("large.txt", { size: 300_000 })]);
    render(<ExplorerPreviewPane {...input} />);
    const text = await screen.findByTestId("explorer-preview-text");
    expect(text).toHaveAttribute("data-line-count", "2");
    expect(text).toHaveTextContent("first");
    expect(text).toHaveTextContent("second");
    expect(screen.getByTestId("explorer-preview-truncated")).toHaveTextContent("first 256 KB");
    expect(explorerReadPreviewText).toHaveBeenCalledWith("/fixture/large.txt");
    fireEvent.click(screen.getByTestId("explorer-preview-open"));
    expect(input.onOpen).toHaveBeenCalledWith(input.entries[0]);
    fireEvent.click(screen.getByTestId("explorer-preview-system"));
    expect(sftpOpenPath).toHaveBeenCalledWith("/fixture/large.txt");
    fireEvent.click(screen.getByTestId("explorer-preview-copy-path"));
    expect(writeText).toHaveBeenCalledWith("/fixture/large.txt");
    fireEvent.click(screen.getByTestId("explorer-preview-close"));
    expect(input.onClose).toHaveBeenCalledTimes(1);
  });

  it("virtualizes a long text preview while rendering the visible numbered lines", async () => {
    vi.mocked(explorerReadPreviewText).mockResolvedValue({ text: Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join("\n"), truncated: false, binary: false });
    render(<ExplorerPreviewPane {...props()} />);
    const text = await screen.findByTestId("explorer-preview-text");
    expect(text).toHaveAttribute("data-line-count", "10000");
    expect(text).toHaveTextContent("line 0");
    expect(text.querySelectorAll(".ex-pv-line").length).toBeLessThan(50);
    expect(text.textContent).not.toContain("line 9999");
  });

  it("uses safe Markdown and CSV renderers rather than HTML from a file", async () => {
    vi.mocked(explorerReadPreviewText).mockResolvedValue({ text: '# Hello\n<script>alert(1)</script>\n![img](https://example.invalid/a.png)', binary: false, truncated: false });
    const view = render(<ExplorerPreviewPane {...props([file("readme.md")])} />);
    expect(await screen.findByTestId("explorer-preview-markdown")).toHaveTextContent("Hello");
    expect(view.container.querySelector("script,[src],[href]")).toBeNull();
    vi.mocked(explorerReadPreviewText).mockResolvedValue({ text: 'id,value\n1,"<img src=x onerror=bad>"', binary: false, truncated: false });
    view.rerender(<ExplorerPreviewPane {...props([file("table.csv")])} />);
    expect(await screen.findByTestId("explorer-preview-csv")).toHaveTextContent("<img src=x onerror=bad>");
    expect(view.container.querySelector("img")).toBeNull();
  });

  it("does not attempt unsupported or oversized image reads and detects binary text", async () => {
    const view = render(<ExplorerPreviewPane {...props([file("binary.bin")])} />);
    await waitFor(() => expect(screen.queryByTestId("explorer-preview-loading")).toBeNull());
    expect(explorerReadPreviewText).not.toHaveBeenCalled();
    expect(explorerReadPreviewBytes).not.toHaveBeenCalled();
    view.rerender(<ExplorerPreviewPane {...props([file("huge.png", { size: 20 * 1024 * 1024 + 1 })])} />);
    await waitFor(() => expect(screen.getByTestId("explorer-preview")).toHaveAttribute("data-preview-kind", "too-large"));
    expect(explorerReadPreviewBytes).not.toHaveBeenCalled();
    vi.mocked(explorerReadPreviewText).mockResolvedValue({ text: "", binary: true, truncated: false });
    view.rerender(<ExplorerPreviewPane {...props([file("binary.txt")])} />);
    await waitFor(() => expect(screen.getByTestId("explorer-preview")).toHaveAttribute("data-preview-kind", "binary"));
    expect(screen.queryByTestId("explorer-preview-text")).toBeNull();
  });

  it("reports load and system-open failures without hiding the selected metadata", async () => {
    vi.mocked(explorerReadPreviewText).mockRejectedValue(new Error("Permission denied"));
    vi.mocked(sftpOpenPath).mockRejectedValue(new Error("No desktop opener"));
    render(<ExplorerPreviewPane {...props()} />);
    expect(await screen.findByTestId("explorer-preview-error")).toHaveTextContent("Permission denied");
    expect(screen.getByTestId("explorer-preview-metadata")).toHaveTextContent("notes.txt");
    fireEvent.click(screen.getByTestId("explorer-preview-system"));
    expect(await screen.findByTestId("explorer-preview-action-error")).toHaveTextContent("No desktop opener");
  });

  it("shows current directory and recursive single/multi selection sizes", async () => {
    const view = render(<ExplorerPreviewPane {...props([])} />);
    await waitFor(() => expect(screen.queryByTestId("explorer-preview-loading")).toBeNull());
    expect(screen.getByTestId("explorer-preview-metadata")).toHaveTextContent("1 items · 40 B");
    view.rerender(<ExplorerPreviewPane {...props([file("folder", { fileType: "dir", size: 0 })])} />);
    expect(await screen.findByText("child.txt")).toBeVisible();
    expect(screen.getByTestId("explorer-preview-metadata")).toHaveTextContent("40 B · 4 items");
    view.rerender(<ExplorerPreviewPane {...props([file("folder", { fileType: "dir", size: 0 }), file("notes.txt")])} />);
    await waitFor(() => expect(screen.queryByTestId("explorer-preview-loading")).toBeNull());
    expect(screen.getByTestId("explorer-preview-metadata")).toHaveTextContent("50 B");
  });
});

describe("Explorer preview lifecycle", () => {
  it("drops stale text responses and hides old content immediately on selection change", async () => {
    const old = deferred<PreviewText>();
    const latest = deferred<PreviewText>();
    vi.mocked(explorerReadPreviewText).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const view = render(<ExplorerPreviewPane {...props([file("old.txt")])} />);
    view.rerender(<ExplorerPreviewPane {...props([file("new.txt")])} />);
    await act(async () => latest.resolve({ text: "new response", truncated: false, binary: false }));
    expect(screen.getByTestId("explorer-preview-text")).toHaveAttribute("data-line-count", "1");
    await act(async () => old.resolve({ text: "stale response\nstale", truncated: false, binary: false }));
    expect(screen.getByTestId("explorer-preview-text")).toHaveAttribute("data-line-count", "1");
    expect(screen.getByTestId("explorer-preview-metadata")).toHaveTextContent("new.txt");
    view.rerender(<ExplorerPreviewPane {...props([file("unknown.bin")])} />);
    expect(screen.queryByTestId("explorer-preview-text")).toBeNull();
  });

  it("does not allocate stale image URLs and revokes every live URL on change and unmount", async () => {
    const first = deferred<PreviewBytes>();
    const second = deferred<PreviewBytes>();
    vi.mocked(explorerReadPreviewBytes).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<ExplorerPreviewPane {...props([file("old.png")])} />);
    view.rerender(<ExplorerPreviewPane {...props([file("new.png")])} />);
    await act(async () => first.resolve({ bytes: [1], mime: "image/png" }));
    expect(createObjectUrl).not.toHaveBeenCalled();
    await act(async () => second.resolve({ bytes: [2], mime: "image/png" }));
    expect(screen.getByTestId("explorer-preview-image")).toHaveAttribute("src", "blob:preview-image");
    view.rerender(<ExplorerPreviewPane {...props([file("notes.txt")])} />);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:preview-image");
    view.rerender(<ExplorerPreviewPane {...props([file("third.png")])} />);
    await screen.findByTestId("explorer-preview-image");
    view.unmount();
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
  });

  it("StrictMode does not publish or leak a URL from the replayed request", async () => {
    const replay = deferred<PreviewBytes>();
    const current = deferred<PreviewBytes>();
    vi.mocked(explorerReadPreviewBytes).mockReturnValueOnce(replay.promise).mockReturnValueOnce(current.promise);
    const view = render(<StrictMode><ExplorerPreviewPane {...props([file("strict.png")])} /></StrictMode>);
    await act(async () => replay.resolve({ bytes: [1], mime: "image/png" }));
    expect(createObjectUrl).not.toHaveBeenCalled();
    await act(async () => current.resolve({ bytes: [2], mime: "image/png" }));
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrent recursive multi-selection scans and cancels before scheduling remaining folders", async () => {
    const pending = deferred<LocalProperties>();
    vi.mocked(localProperties).mockReturnValue(pending.promise);
    const entries = Array.from({ length: 20 }, (_, index) => file(`folder-${index}`, { fileType: "dir", size: 0 }));
    const view = render(<ExplorerPreviewPane {...props(entries)} />);
    expect(localProperties).toHaveBeenCalledTimes(4);
    view.unmount();
    expect(explorerCancelOperation).toHaveBeenCalledTimes(4);
    await act(async () => pending.resolve(metadata()));
    expect(localProperties).toHaveBeenCalledTimes(4);
  });

  it("cancels each live recursive property operation on StrictMode replay and unmount", async () => {
    const pending = deferred<LocalProperties>();
    vi.mocked(localProperties).mockReturnValue(pending.promise);
    const view = render(<StrictMode><ExplorerPreviewPane {...props([file("folder", { fileType: "dir" })])} /></StrictMode>);
    expect(localProperties).toHaveBeenCalledTimes(2);
    const ids = vi.mocked(localProperties).mock.calls.map((call) => call[1]);
    expect(ids[0]).not.toEqual(ids[1]);
    expect(explorerCancelOperation).toHaveBeenCalledWith(ids[0]);
    view.unmount();
    expect(explorerCancelOperation).toHaveBeenCalledWith(ids[1]);
    await act(async () => pending.resolve(metadata()));
    expect(createObjectUrl).not.toHaveBeenCalled();
  });
});

describe("Explorer shared preview preferences", () => {
  it("persists bottom/right placement and word wrap and updates every mounted pane", async () => {
    const view = render(<div><ExplorerPreviewPane {...props()} /><ExplorerPreviewPane {...props([file("other.txt")])} /></div>);
    await screen.findAllByTestId("explorer-preview-text");
    fireEvent.click(screen.getAllByTestId("explorer-preview-settings")[0]);
    fireEvent.click(screen.getByTestId("explorer-preview-bottom"));
    expect(getExplorerPreferences().previewPosition).toBe("bottom");
    for (const pane of screen.getAllByTestId("explorer-preview")) expect(pane).toHaveAttribute("data-position", "bottom");
    fireEvent.click(screen.getAllByTestId("explorer-preview-settings")[0]);
    fireEvent.click(screen.getByTestId("explorer-preview-wrap"));
    expect(getExplorerPreferences().wrap).toBe(true);
    for (const text of screen.getAllByTestId("explorer-preview-text")) expect(text).toHaveClass("ex-pv-wrap");
    fireEvent.click(screen.getAllByTestId("explorer-preview-settings")[0]);
    fireEvent.click(screen.getByTestId("explorer-preview-right"));
    expect(getExplorerPreferences().previewPosition).toBe("right");
    view.unmount();
  });
});
