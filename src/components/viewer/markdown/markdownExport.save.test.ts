import { beforeEach, expect, it, vi } from "vitest";
import { exportMarkdown } from "./markdownExport";
import { DEFAULT_EXPORT_SETTINGS, prepareMarkdownExport } from "./exportModel";
import { markdownPdf } from "./exportPdf";
import { explorerCanonicalPath } from "../../../lib/explorer";
import { selectSaveFilePath, writeStreamOpen, writeStreamAppend, writeStreamClose } from "../../../lib/ipc";

vi.mock("./exportModel", async (original) => ({ ...await original<typeof import("./exportModel")>(), prepareMarkdownExport: vi.fn() }));
vi.mock("./exportPdf", () => ({ markdownPdf: vi.fn() }));
vi.mock("../../../lib/runtime", () => ({ isTauriRuntime: () => true, getAppPlatform: () => "linux" }));
vi.mock("../../../lib/clipboard", () => ({ writeText: vi.fn(), writeMultiFormat: vi.fn() }));
vi.mock("../../../lib/explorer", () => ({ explorerCanonicalPath: vi.fn(), localCreateEntry: vi.fn() }));
vi.mock("../../../lib/explorer/openExplorer", () => ({ explorerPathKey: (path: string) => path }));
vi.mock("../../../lib/ipc", () => ({ selectSaveFilePath: vi.fn(), selectSaveDirectory: vi.fn(), writeStreamOpen: vi.fn(), writeStreamAppend: vi.fn(), writeStreamClose: vi.fn(), writeStreamAbort: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prepareMarkdownExport).mockResolvedValue({ root: document.createElement("div"), title: "a.md", css: "", html: "<p>Document</p>" });
  vi.mocked(explorerCanonicalPath).mockImplementation(async (path) => path);
  vi.mocked(writeStreamOpen).mockResolvedValue("stream");
});

it("cancels native PDF export before expensive encoding or opening a stream", async () => {
  vi.mocked(selectSaveFilePath).mockResolvedValue(null);
  expect(await exportMarkdown("pdf", "# Document", "/docs/a.md", DEFAULT_EXPORT_SETTINGS)).toEqual({ status: "cancelled" });
  expect(markdownPdf).not.toHaveBeenCalled();
  expect(writeStreamOpen).not.toHaveBeenCalled();
});

it("rejects source aliases before rendering or truncation", async () => {
  vi.mocked(selectSaveFilePath).mockResolvedValue("/output/alias.pdf");
  vi.mocked(explorerCanonicalPath).mockResolvedValue("/docs/a.md");
  await expect(exportMarkdown("pdf", "# Document", "/docs/a.md", DEFAULT_EXPORT_SETTINGS)).rejects.toThrow("source is never overwritten");
  expect(markdownPdf).not.toHaveBeenCalled();
  expect(writeStreamOpen).not.toHaveBeenCalled();
});

it("selects the destination before encoding and publishes only complete PDF bytes", async () => {
  const events: string[] = [];
  const bytes = Uint8Array.of(37,80,68,70);
  vi.mocked(selectSaveFilePath).mockImplementation(async () => { events.push("choose"); return "/out/a.pdf"; });
  vi.mocked(markdownPdf).mockImplementation(async () => {
    events.push("encode");
    expect(writeStreamOpen).not.toHaveBeenCalled();
    return { arrayBuffer: async () => bytes.buffer } as Blob;
  });
  vi.mocked(writeStreamOpen).mockImplementation(async () => { events.push("publish"); return "stream"; });
  expect(await exportMarkdown("pdf", "# Document", "/docs/a.md", DEFAULT_EXPORT_SETTINGS)).toEqual({ status: "saved", path: "/out/a.pdf" });
  expect(events).toEqual(["choose", "encode", "publish"]);
  expect(writeStreamAppend).toHaveBeenCalledWith("stream", bytes);
  expect(writeStreamClose).toHaveBeenCalledOnce();
});

it("leaves the destination untouched if generation fails after selection", async () => {
  vi.mocked(selectSaveFilePath).mockResolvedValue("/out/a.pdf");
  vi.mocked(markdownPdf).mockRejectedValue(new Error("encoding failed"));
  await expect(exportMarkdown("pdf", "# Document", "/docs/a.md", DEFAULT_EXPORT_SETTINGS)).rejects.toThrow("encoding failed");
  expect(writeStreamOpen).not.toHaveBeenCalled();
});
