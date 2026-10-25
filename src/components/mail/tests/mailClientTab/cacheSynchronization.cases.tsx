import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { MailMessageHeader, MailSyncAllResult } from "../../../../lib/mail";
import { MailClientTab } from "../../MailClientTab";
import { folder, info, mailMocks, message, renderMailbox, stepResult } from "./harness";

export function registerMailCacheSynchronizationCases() {
  it("retains a completed folder-read notice when an earlier manual sync finishes", async () => {
    let finishSync!: (result: MailSyncAllResult) => void;
    const readFolder = { ...folder, unread: 0 };
    const readMessage = { ...message, flags: ["\\Seen"] };
    mailMocks.mailListCachedFolders.mockResolvedValue([{ ...folder, unread: 1 }]);
    mailMocks.mailSyncAllFolders.mockImplementationOnce(() => new Promise((resolve) => { finishSync = resolve; }));
    mailMocks.mailMarkRead.mockImplementation(async () => {
      mailMocks.mailListCachedFolders.mockResolvedValue([readFolder]);
      mailMocks.mailListCachedMessages.mockResolvedValue([readMessage]);
      return { folder: "INBOX", marked: 1 };
    });
    renderMailbox();
    await screen.findByTestId("mail-message-row");
    fireEvent.click(screen.getByTestId("mail-sync-button"));
    await waitFor(() => expect(finishSync).toBeDefined());
    fireEvent.click(screen.getByTestId("mail-mark-folder-read"));
    await screen.findByText("Marked 1 messages as read");

    await act(async () => finishSync({
      accountId: info.sessionId, folders: [readFolder], fetchedMessages: 0,
      newMessages: 0, cachedBodies: 0, syncedAt: 0,
    }));
    await waitFor(() => expect(screen.getByTestId("mail-sync-button")).toBeEnabled());
    expect(screen.getByTestId("mail-client-tab")).toHaveTextContent("Marked 1 messages as read");
    expect(screen.getByTestId("mail-message-row")).toHaveAttribute("data-unread", "false");
  });

  it("loads headers cached by the archive even when foreground sync fetches nothing", async () => {
    mailMocks.mailListCachedMessages.mockResolvedValue([message]);
    mailMocks.mailListCachedMessages.mockResolvedValueOnce([]);
    // The archive has published these headers before the foreground sync's
    // watermark read. No new headers in that sync does not mean an empty cache.
    mailMocks.mailSyncFolder.mockResolvedValue(stepResult({}));

    render(<MailClientTab tabId="mail-tab" info={{ ...info, sync: { ...info.sync, onOpen: true } }} visible />);

    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "1"));
    expect(screen.getByTestId("mail-message-row")).toHaveTextContent(message.subject);
  });

  it("keeps the post-sync cache page when the initial empty snapshot arrives late", async () => {
    let finishInitial!: (value: MailMessageHeader[]) => void;
    mailMocks.mailListCachedMessages.mockResolvedValue([message]);
    mailMocks.mailListCachedMessages.mockImplementationOnce(() => new Promise((resolve) => { finishInitial = resolve; }));
    mailMocks.mailSyncFolder.mockResolvedValue(stepResult({ messages: [message], fetched: 1 }));

    render(<MailClientTab tabId="mail-tab" info={{ ...info, sync: { ...info.sync, onOpen: true } }} visible />);

    await waitFor(() => expect(mailMocks.mailListCachedMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "1"));
    await act(async () => finishInitial([]));
    expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "1");
    expect(screen.getByTestId("mail-message-row")).toHaveTextContent(message.subject);
  });
}
