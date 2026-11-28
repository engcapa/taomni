import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { openFile } from "../../lib/openFile";
import { listArchive, previewArchiveEntry } from "../../lib/openFile/archive";
import { ArchiveViewer } from "./ArchiveViewer";

vi.mock("../../lib/openFile", async (original) => ({
  ...await original<typeof import("../../lib/openFile")>(), openFile: vi.fn(),
}));
vi.mock("../../lib/openFile/archive", async (original) => ({
  ...await original<typeof import("../../lib/openFile/archive")>(),
  listArchive: vi.fn(), previewArchiveEntry: vi.fn(), archiveExtraction: { status: async () => null },
}));

afterEach(cleanup);

it("previews the selected document member as a read-only temp in its archive's host", async () => {
  setLocale("en");
  const entries = ["notes.rtf", "order.pdf", "nested.zip", "run.exe", "folder.docx"].map((name, index) => ({
    name, index, directory: index === 4, size: 24, crc: 10 + index,
  }));
  vi.mocked(listArchive).mockResolvedValue(entries);
  vi.mocked(previewArchiveEntry).mockResolvedValue({ path: "/tmp/archive/notes.rtf", token: "test" });
  render(<ArchiveViewer viewer={{ path: "/docs/bundle.zip", kind: "archive" }} workspaceId="docs" host="explorer" />);

  const rows = await screen.findAllByTestId("archive-entry");
  expect(within(rows[1]).getByRole("button", { name: "Preview order.pdf" })).toBeEnabled();
  for (const row of rows.slice(2)) expect(within(row).queryByTestId("archive-preview")).toBeNull();
  fireEvent.click(within(rows[0]).getByRole("button", { name: "Preview notes.rtf" }));
  await waitFor(() => expect(openFile).toHaveBeenCalledWith(
    { path: "/tmp/archive/notes.rtf", source: "remote-temp", readOnlyReason: "Read-only archive entry" },
    { context: "archive-preview", mode: "taomni", workspaceId: "docs", host: "explorer" },
  ));
  expect(previewArchiveEntry).toHaveBeenCalledWith("/docs/bundle.zip", entries[0]);
});
