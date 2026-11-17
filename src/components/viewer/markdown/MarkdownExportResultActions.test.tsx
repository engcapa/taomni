import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownExportResultActions } from "./MarkdownExportResultActions";
import { openFile } from "../../../lib/openFile";
import { openExplorer } from "../../../lib/explorer/openExplorer";
import { sftpOpenPath } from "../../../lib/sftp";

vi.mock("../viewerLabels", () => ({ useViewerLabels: () => (_zh: string, en: string) => en }));
vi.mock("../../../lib/openFile", async (original) => ({ ...await original<typeof import("../../../lib/openFile")>(), openFile: vi.fn(async () => "viewer") }));
vi.mock("../../../lib/explorer/openExplorer", () => ({ openExplorer: vi.fn(async () => "explorer") }));
vi.mock("../../../lib/sftp", () => ({ sftpOpenPath: vi.fn(async () => undefined) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each(["html", "png", "md"])("opens the saved %s in Tao first and keeps the system action secondary", async (extension) => {
  const file = `/exports/report.${extension}`;
  render(<MarkdownExportResultActions path={file} filePath={file} workspaceId="owner" onError={vi.fn()} />);
  const buttons = screen.getAllByRole("button");
  expect(buttons[0]).toHaveTextContent("Open with Tao");
  expect(buttons[0]).toHaveClass("primary");
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(openFile).toHaveBeenCalledWith(file, { context: "markdown-export", mode: "taomni", workspaceId: "owner" }));
  expect(sftpOpenPath).not.toHaveBeenCalled();
  fireEvent.click(buttons[1]);
  await waitFor(() => expect(sftpOpenPath).toHaveBeenCalledWith("/exports/"));
});

it.each(["docx", "pdf", "drawio"])("shows saved %s in Tao Explorer without silently launching an external app", async (extension) => {
  const file = `C:\\exports\\report.${extension}`;
  render(<MarkdownExportResultActions path={file} filePath={file} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Show in Tao" }));
  await waitFor(() => expect(openExplorer).toHaveBeenCalledWith("C:/exports/", { workspaceId: undefined }));
  expect(sftpOpenPath).not.toHaveBeenCalled();
  expect(openFile).not.toHaveBeenCalled();
});

it("opens a bundled Markdown document while revealing its export directory to the system", async () => {
  render(<MarkdownExportResultActions path="/exports/report-2" filePath="/exports/report-2/report.md" onError={vi.fn()} />);
  fireEvent.click(screen.getByTestId("markdown-export-open-tao"));
  await waitFor(() => expect(openFile).toHaveBeenCalledWith("/exports/report-2/report.md", expect.anything()));
  fireEvent.click(screen.getByTestId("markdown-export-show-system"));
  await waitFor(() => expect(sftpOpenPath).toHaveBeenCalledWith("/exports/report-2"));
});

it("surfaces a failed open and keeps both actions available for recovery", async () => {
  const onError = vi.fn();
  vi.mocked(openFile).mockRejectedValueOnce(new Error("Export was moved"));
  render(<MarkdownExportResultActions path="/out/a.html" filePath="/out/a.html" onError={onError} />);
  fireEvent.click(screen.getByTestId("markdown-export-open-tao"));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("Export was moved"));
  expect(screen.getByTestId("markdown-export-show-system")).toBeEnabled();
});
