import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MailArchiveDialog } from "./MailArchiveDialog";
import type { MailArchiveEntry, MailArchiveQuery } from "../../lib/mail";
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
vi.mock("../../lib/ipc", () => ({ selectSaveFilePath: vi.fn() }));
const entries: MailArchiveEntry[] = Array.from({ length: 250 }, (_, i) => ({ folder: "INBOX", uid: i + 1, uidValidity: 10, subject: `Invoice ${i + 1}`, from: "Alice", to: "Bob", dateTs: 1700000000, hasAttachments: true, rawSize: 2048, storedSize: 500, storedAt: 1700000000 }));
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  ipc.invoke.mockImplementation(async (cmd: string, args: { offset?: number; query?: MailArchiveQuery }) => {
    if (cmd === "mail_archive_query") return { entries: entries.slice(args.offset || 0, (args.offset || 0) + 200), offset: args.offset || 0, total: 250, storedBytes: 125000, folders: ["INBOX", "&U,BTFw-"] };
    if (cmd === "mail_archive_preview_cleanup") return { token: "frozen", count: 2, storedBytes: 1000, reclaimableBytes: 500 };
    if (cmd === "mail_archive_cleanup") return 2;
  });
});
afterEach(cleanup);
async function open() {
  render(<MailArchiveDialog accountId="qa" onClose={vi.fn()} onChanged={async () => {}} />);
  await waitFor(() => expect(screen.getByTestId("mail-archive-results")).toHaveTextContent("of 250"));
}
it("retains explicit selections across pages and freezes cleanup before confirmation", async () => {
  await open(); fireEvent.click(screen.getByLabelText("Select Invoice 1"));
  fireEvent.click(screen.getByTestId("mail-archive-next"));
  await screen.findByLabelText("Select Invoice 201"); fireEvent.click(screen.getByLabelText("Select Invoice 201"));
  expect(screen.getByTestId("mail-archive-selection-count")).toHaveTextContent("2 selected");
  fireEvent.click(screen.getByTestId("mail-archive-cleanup")); await screen.findByTestId("mail-archive-confirm");
  expect(ipc.invoke).toHaveBeenCalledWith("mail_archive_preview_cleanup", { accountId: "qa", selection: { keys: [{ folder: "INBOX", uid: 1, uidValidity: 10 }, { folder: "INBOX", uid: 201, uidValidity: 10 }] } });
  expect(screen.getByTestId("mail-archive-cleanup-estimate")).toHaveTextContent("Up to 500 B reclaimable");
  expect(screen.getByTestId("mail-archive-search")).toBeDisabled();
  fireEvent.click(screen.getByTestId("mail-archive-confirm-cancel"));
  expect(ipc.invoke.mock.calls.some(([cmd]) => cmd === "mail_archive_cleanup")).toBe(false);
  fireEvent.click(screen.getByTestId("mail-archive-cleanup")); await screen.findByTestId("mail-archive-confirm");
  fireEvent.click(screen.getByTestId("mail-archive-confirm-remove"));
  await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("mail_archive_cleanup", { accountId: "qa", token: "frozen" }));
});
it("supports all matching with exclusions and clears selection when filtering", async () => {
  await open(); fireEvent.click(screen.getByTestId("mail-archive-select-all"));
  fireEvent.click(screen.getByLabelText("Select Invoice 1"));
  expect(screen.getByTestId("mail-archive-selection-count")).toHaveTextContent("249 selected across all pages");
  fireEvent.click(screen.getByTestId("mail-archive-cleanup")); await screen.findByTestId("mail-archive-confirm");
  expect(ipc.invoke).toHaveBeenCalledWith("mail_archive_preview_cleanup", expect.objectContaining({ selection: expect.objectContaining({ query: expect.objectContaining({ text: "" }), excluded: [{ folder: "INBOX", uid: 1, uidValidity: 10 }] }) }));
  fireEvent.click(screen.getByTestId("mail-archive-confirm-cancel"));
  fireEvent.change(screen.getByTestId("mail-archive-search"), { target: { value: "Alice" } });
  expect(screen.getByTestId("mail-archive-selection-count")).toHaveTextContent("0 selected");
  expect(screen.getByTestId("mail-archive-cleanup")).toBeDisabled();
});
it("sends combined whole-archive filters with inclusive local end dates and size units", async () => {
  await open();
  for (const [id, value] of [["search-field", "from"], ["folder", "&U,BTFw-"], ["attachments", "yes"], ["date-from", "2025-01-01"], ["date-to", "2025-01-31"], ["stored-from", "2025-02-01"], ["stored-to", "2025-02-28"], ["min-size", "1.5"], ["max-size", "20"], ["search", "alice@example.com"], ["sort", "largest"]]) fireEvent.change(screen.getByTestId(`mail-archive-${id}`), { target: { value } });
  await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("mail_archive_query", { accountId: "qa", offset: 0, query: { text: "alice@example.com", field: "from", folder: "&U,BTFw-", hasAttachments: true, dateFrom: new Date("2025-01-01T00:00:00").getTime() / 1000, dateBefore: new Date("2025-02-01T00:00:00").getTime() / 1000, storedFrom: new Date("2025-02-01T00:00:00").getTime() / 1000, storedBefore: new Date("2025-03-01T00:00:00").getTime() / 1000, minSize: 1572864, maxSize: 20971520, sort: "largest" } }));
  fireEvent.change(screen.getByTestId("mail-archive-max-size"), { target: { value: "0.1" } });
  expect(screen.getByRole("alert")).toHaveTextContent("valid size range"); expect(screen.getByTestId("mail-archive-select-all")).toBeDisabled();
});
it("ignores stale search responses and prevents keyboard cleanup while typing", async () => {
  await open();
  let resolveOld!: (v: unknown) => void;
  const previous = ipc.invoke.getMockImplementation()!;
  ipc.invoke.mockImplementation((cmd: string, args: { query?: MailArchiveQuery }) => cmd === "mail_archive_query" && args.query?.text === "old" ? new Promise((resolve) => { resolveOld = resolve; }) : previous(cmd, args));
  fireEvent.change(screen.getByTestId("mail-archive-search"), { target: { value: "old" } });
  await waitFor(() => expect(resolveOld).toBeDefined());
  fireEvent.change(screen.getByTestId("mail-archive-search"), { target: { value: "new" } });
  await waitFor(() => expect(screen.getByTestId("mail-archive-results")).toHaveTextContent("of 250"));
  resolveOld({ entries: [], offset: 0, total: 0, storedBytes: 0, folders: [] });
  fireEvent.keyDown(screen.getByTestId("mail-archive-entries"), { key: "a", ctrlKey: true });
  expect(screen.getByTestId("mail-archive-selection-count")).toHaveTextContent("200 selected");
  fireEvent.keyDown(screen.getByTestId("mail-archive-search"), { key: "Delete" });
  expect(ipc.invoke.mock.calls.some(([cmd]) => cmd === "mail_archive_preview_cleanup")).toBe(false);
  fireEvent.keyDown(screen.getByTestId("mail-archive-entries"), { key: "f", ctrlKey: true });
  expect(screen.getByTestId("mail-archive-search")).toHaveFocus();
});
