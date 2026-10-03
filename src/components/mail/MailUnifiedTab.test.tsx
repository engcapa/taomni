import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailFolder, MailMessageHeader } from "../../lib/mail";
import type { MailTabInfo } from "../../types";

const mailMocks = vi.hoisted(() => ({
  mailListCachedFolders: vi.fn(),
  mailListCachedMessages: vi.fn(),
  mailSearchMessages: vi.fn(),
  mailGetMessageBody: vi.fn(),
  mailSetFlags: vi.fn(),
  mailMoveMessages: vi.fn(),
  mailDeleteMessages: vi.fn(),
  mailSyncFolder: vi.fn(),
}));

vi.mock("../../lib/mail", () => mailMocks);

import { MailUnifiedTab } from "./MailUnifiedTab";

function account(id: string, email: string): MailTabInfo {
  return { sessionId: id, emailAddress: email, displayName: null } as unknown as MailTabInfo;
}

function folder(accountId: string, name: string, flags: string[] = []): MailFolder {
  return { accountId, name, displayName: name, flags, updatedAt: 0, syncComplete: true };
}

function message(accountId: string, uid: number, subject: string, dateTs: number, flags: string[] = []): MailMessageHeader {
  return {
    accountId,
    folder: "INBOX",
    uid,
    subject,
    from: { name: `${accountId} sender`, address: `${accountId}@example.com` },
    to: [],
    cc: [],
    dateTs,
    flags,
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    bodyCached: false,
    references: [],
    snippet: `${subject} snippet`,
  } as MailMessageHeader;
}

const work = account("work", "me@work.example");
const home = account("home", "me@home.example");

describe("MailUnifiedTab", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    for (const mock of Object.values(mailMocks)) mock.mockReset();
    mailMocks.mailListCachedFolders.mockImplementation(async (id: string) => [
      folder(id, "INBOX"),
      folder(id, id === "work" ? "Deleted Items" : "Trash", ["\\Trash"]),
      folder(id, "Projects"),
    ]);
    mailMocks.mailListCachedMessages.mockImplementation(async (id: string) => (id === "work"
      ? [message("work", 7, "Work newest", 300), message("work", 5, "Work older", 100)]
      : [message("home", 7, "Home middle", 200, ["\\Seen"])]));
    mailMocks.mailGetMessageBody.mockResolvedValue({ text: "hello body", html: null, attachments: [] });
    mailMocks.mailSetFlags.mockResolvedValue({ folder: "INBOX", updated: 1 });
    mailMocks.mailMoveMessages.mockResolvedValue({ folder: "INBOX", target: "x", count: 1 });
    mailMocks.mailSyncFolder.mockResolvedValue({ fetched: 2, more: false });
    mailMocks.mailSearchMessages.mockResolvedValue([]);
  });

  it("merges every account's inbox by time and acts on the owning account (AC-48)", async () => {
    render(<MailUnifiedTab accounts={[work, home]} visible />);
    await waitFor(() => expect(screen.getAllByTestId("mail-unified-row")).toHaveLength(3));
    const rows = screen.getAllByTestId("mail-unified-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Work newest"),
      expect.stringContaining("Home middle"),
      expect.stringContaining("Work older"),
    ]);
    expect(within(rows[1]).getByTestId("mail-unified-account")).toHaveTextContent("me@home.example");
    expect(screen.getByTestId("mail-unified-count")).toHaveAttribute("data-unread", "2");

    // Same UID in both accounts: opening the home one uses the home account.
    fireEvent.click(rows[1]);
    await waitFor(() => expect(mailMocks.mailGetMessageBody).toHaveBeenCalledWith(home, "INBOX", 7));
    expect(await screen.findByText("hello body")).toBeInTheDocument();
    expect(mailMocks.mailSetFlags).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("mail-unified-move"), { target: { value: "Projects" } });
    await waitFor(() => expect(mailMocks.mailMoveMessages).toHaveBeenCalledWith(home, "INBOX", [7], "Projects"));
    await waitFor(() => expect(screen.getAllByTestId("mail-unified-row")).toHaveLength(2));

    fireEvent.click(screen.getAllByTestId("mail-unified-row")[0]);
    await waitFor(() => expect(mailMocks.mailSetFlags).toHaveBeenCalledWith(work, "INBOX", [7], ["\\Seen"], []));
    fireEvent.click(screen.getByTestId("mail-unified-delete"));
    await waitFor(() => expect(mailMocks.mailMoveMessages).toHaveBeenLastCalledWith(work, "INBOX", [7], "Deleted Items"));
  });

  it("gets mail for every account and reports a failing one", async () => {
    mailMocks.mailSyncFolder.mockImplementation(async (info: MailTabInfo) => {
      if (info.sessionId === "home") throw new Error("login failed");
      return { fetched: 2, more: false };
    });
    render(<MailUnifiedTab accounts={[work, home]} visible />);
    await waitFor(() => expect(screen.getAllByTestId("mail-unified-row")).toHaveLength(3));
    fireEvent.click(screen.getByTestId("mail-unified-refresh"));
    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(2));
    expect(mailMocks.mailSyncFolder).toHaveBeenCalledWith(work, "INBOX", expect.objectContaining({ mode: "auto" }));
    expect(await screen.findByTestId("mail-unified-account-error")).toHaveTextContent("me@home.example: Error: login failed");
    expect(screen.getByTestId("mail-unified-status")).toHaveTextContent("Fetched 2 new messages");
  });

  it("starred searches every folder of each account", async () => {
    mailMocks.mailSearchMessages.mockImplementation(async (id: string) =>
      id === "home" ? [message("home", 3, "Starred home", 50, ["\\Flagged"])] : []);
    render(<MailUnifiedTab accounts={[work, home]} visible />);
    fireEvent.click(await screen.findByTestId("mail-unified-view-starred"));
    await waitFor(() => expect(screen.getAllByTestId("mail-unified-row")).toHaveLength(1));
    expect(mailMocks.mailSearchMessages).toHaveBeenCalledWith("work", expect.objectContaining({ flaggedOnly: true, text: "" }));
  });

  it("explains when there are no accounts", () => {
    render(<MailUnifiedTab accounts={[]} visible />);
    expect(screen.getByTestId("mail-unified-empty")).toBeInTheDocument();
  });
});
