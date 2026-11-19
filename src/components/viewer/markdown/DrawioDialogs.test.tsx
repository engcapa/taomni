import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DrawioImportDialog } from "./DrawioImportDialog";
import { MarkdownExportMenu } from "./MarkdownExportMenu";
import { drawioCell, newDrawioPage } from "./drawioCodec";
import type { ViewerDocument } from "../../../lib/viewer";

vi.mock("../viewerLabels", () => ({ useViewerLabels: () => (_zh: string, en: string) => en }));
vi.mock("./drawioRender", async (original) => ({ ...await original<typeof import("./drawioRender")>(), renderDrawioPage: vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Sheet preview</text></svg>', width: 200, height: 80, warnings: [], missingImages: 1 })) }));
afterEach(cleanup);

it("requires an explicit import mode, previews sheets and inserts only checked pages", async () => {
  const a = newDrawioPage("a", "First"), b = newDrawioPage("b", "Second");
  drawioCell(a, { id: "a", vertex: 1, style: "text;", value: "First content" }, { width: 200, height: 60 });
  const insert = vi.fn();
  render(<DrawioImportDialog pages={[a, b]} onCancel={vi.fn()} onInsert={insert} />);
  expect(screen.getByTestId("markdown-drawio-import-confirm")).toBeDisabled();
  await waitFor(() => expect(screen.getByTestId("markdown-drawio-import-preview")).toHaveTextContent("Sheet preview"));
  expect(screen.getByRole("status")).toHaveTextContent("1 image unavailable offline. Original reference preserved.");
  fireEvent.click(screen.getByLabelText("Import sheet Second"));
  fireEvent.click(screen.getByTestId("markdown-drawio-import-text"));
  fireEvent.click(screen.getByTestId("markdown-drawio-import-confirm"));
  expect(insert).toHaveBeenCalledOnce();
  expect(insert.mock.calls[0][0]).toContain("First content"); expect(insert.mock.calls[0][0]).not.toContain("Second");
  expect(insert.mock.calls[0][0]).toContain("```drawio-source");
});

it("routes document/images and Sheet layout to the existing Notes export owner and restores focus after cancellation", async () => {
  const onExport = vi.fn(async () => ({ status: "copied" as const, drawio: { pages: 2, nativeDiagrams: 1, fallbackDiagrams: 0 } }));
  render(<MarkdownExportMenu document={{ path: "note.md", content: "# Note", loading: false } as ViewerDocument} onError={vi.fn()} onExport={onExport} />);
  fireEvent.click(screen.getByTestId("markdown-export")); fireEvent.click(screen.getByTestId("markdown-export-drawio"));
  fireEvent.click(screen.getByTestId("markdown-drawio-scope"));
  fireEvent.click(screen.getByRole("option", { name: "All images and diagrams" }));
  fireEvent.click(screen.getByTestId("markdown-drawio-layout"));
  fireEvent.click(screen.getByRole("option", { name: "All content in one sheet" }));
  fireEvent.click(screen.getByTestId("markdown-drawio-copy-link"));
  await waitFor(() => expect(onExport).toHaveBeenCalledWith("drawio-link", "# Note", expect.objectContaining({ drawio: { scope: "images", layout: "single" } })));
  expect(screen.getByTestId("markdown-export-status")).toHaveAttribute("data-export-state", "copied");
  expect(screen.getByTestId("markdown-export-status")).toHaveTextContent("1 editable diagrams");
  fireEvent.click(screen.getByTestId("markdown-export")); fireEvent.click(screen.getByTestId("markdown-export-drawio"));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByTestId("markdown-export")).toHaveFocus();
});
