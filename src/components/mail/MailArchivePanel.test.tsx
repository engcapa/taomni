import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MailTabInfo } from "../../types";
import { MailArchivePanel } from "./MailArchivePanel";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
vi.mock("../../lib/ipc", () => ({ selectSaveFilePath: ipc.save }));
vi.mock("./MailMessageBodyView", () => ({ MailMessageBodyView: ({ text }: { text: string }) => <p>{text}</p> }));
const entry = { folder: "INBOX", uid: 7, uidValidity: 20, subject: "Retained original", rawSize: 600000, storedSize: 1000, storedAt: 1 };
const info = { sessionId: "qa", incoming: "imap", cache: {} } as MailTabInfo;
let saved = [entry];
beforeEach(() => {
  vi.clearAllMocks(); saved = [entry];
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  ipc.save.mockResolvedValue("/qa/original.eml");
  ipc.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "mail_archive_status") return { phase: "completed", saved: 1, total: 1, bytes: 600000, totalBytes: 600000 };
    if (cmd === "mail_archive_list") return saved;
    if (cmd === "mail_archive_read") return { subject: entry.subject, text: "Offline original body", attachments: [{ name: "large.bin" }] };
    if (cmd === "mail_archive_remove") { saved = []; return 1; }
    return undefined;
  });
});
afterEach(cleanup);

it("starts an account-owned task and leaves it running when the tab unmounts", async () => {
  const view = render(<MailArchivePanel info={info} />);
  await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("mail_archive_start", { config: info, resume: false }));
  view.unmount();
  expect(ipc.invoke.mock.calls.filter(([cmd]) => cmd === "mail_archive_pause")).toHaveLength(0);
});

it("reads retained originals, exports attachments, and cleans up only after confirmation", async () => {
  render(<MailArchivePanel info={info} />);
  fireEvent.click(screen.getByTestId("mail-archive-open"));
  await waitFor(() => expect(screen.getByTestId("mail-archive-read")).toBeDefined());
  fireEvent.click(screen.getByTestId("mail-archive-read"));
  await screen.findByText("Offline original body");
  fireEvent.click(screen.getByTestId("mail-archive-export"));
  await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("mail_archive_export", { accountId: "qa", entry, targetPath: "/qa/original.eml" }));
  await waitFor(() => expect(screen.getByTestId("mail-archive-attachment")).not.toBeDisabled());
  fireEvent.click(screen.getByTestId("mail-archive-attachment"));
  await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("mail_archive_attachment", { accountId: "qa", entry, attachmentIndex: 0, targetPath: "/qa/original.eml" }));
  fireEvent.click(screen.getByLabelText("Select Retained original"));
  await waitFor(() => expect(screen.getByTestId("mail-archive-cleanup")).not.toBeDisabled());
  fireEvent.click(screen.getByTestId("mail-archive-cleanup"));
  fireEvent.click(screen.getByTestId("mail-archive-confirm-cancel"));
  expect(ipc.invoke.mock.calls.some(([cmd]) => cmd === "mail_archive_remove")).toBe(false);
  fireEvent.click(screen.getByTestId("mail-archive-cleanup"));
  fireEvent.click(screen.getByTestId("mail-archive-confirm-remove"));
  await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("mail_archive_remove", { accountId: "qa", entries: [entry] }));
  await screen.findByText("No complete messages stored yet.");
});

it("reports archive read errors while allowing streaming original export", async () => {
  const previous = ipc.invoke.getMockImplementation()!;
  ipc.invoke.mockImplementation((cmd: string, args: unknown) => cmd === "mail_archive_read" ? Promise.reject("Saved email exceeds the reader limit") : previous(cmd, args));
  render(<MailArchivePanel info={info} />);
  await act(async () => fireEvent.click(screen.getByTestId("mail-archive-open")));
  fireEvent.click(screen.getByTestId("mail-archive-read"));
  await screen.findByText("Saved email exceeds the reader limit");
  fireEvent.click(screen.getByTestId("mail-archive-export"));
  await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("mail_archive_export", expect.objectContaining({ entry })));
});

it("shows contextual incomplete content and retries through the account-owned job", async () => {
  let resumed = false;
  const previous = ipc.invoke.getMockImplementation()!;
  ipc.invoke.mockImplementation((cmd: string, args: { resume?: boolean }) => {
    if (cmd === "mail_archive_start" && args.resume) resumed = true;
    if (cmd === "mail_archive_status") return Promise.resolve(resumed
      ? { phase: "completed", saved: 1, total: 1, bytes: 537, totalBytes: 537 }
      : { phase: "failed", saved: 1, total: 2, error: "INBOX, UID 7: empty full email chunk at offset 0" });
    return previous(cmd, args);
  });
  render(<MailArchivePanel info={info} />);
  await screen.findByText("INBOX, UID 7: empty full email chunk at offset 0");
  expect(screen.getByTestId("mail-storage-progress")).toHaveTextContent("1/2");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("mail_archive_start", { config: info, resume: true }));
  await waitFor(() => expect(screen.getByTestId("mail-storage-progress")).toHaveTextContent("completed"));
  expect(screen.queryByText("INBOX, UID 7: empty full email chunk at offset 0")).not.toBeInTheDocument();
});
