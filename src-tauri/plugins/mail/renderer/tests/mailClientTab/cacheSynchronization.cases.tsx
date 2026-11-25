import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { MailFolderSyncResult, MailMessageBody, MailMessageHeader, MailSyncAllResult } from "../../../../../../src/lib/mail";
import { MailClientTab } from "../../MailClientTab";
import { eventMocks, folder, info, mailMocks, message, messageBody, renderMailbox, stepResult } from "./harness";

export function registerMailCacheSynchronizationCases() {
  it("discards an IDLE refresh queued before clearing the cache", async () => {
    mailMocks.mailClearCache.mockImplementation(async () => {
      mailMocks.mailListCachedFolders.mockResolvedValue([]);
      mailMocks.mailListCachedMessages.mockResolvedValue([]);
    });
    renderMailbox();
    await screen.findByTestId("mail-message-row");

    vi.useFakeTimers();
    try {
      const notifyIdle = eventMocks.handlers.get("mail://idle")!;
      act(() => notifyIdle({ payload: { accountId: info.sessionId, kind: "changed" } }));
      await act(async () => fireEvent.click(screen.getByTitle("Clear this account cache")));
      expect(screen.getByTestId("mail-client-tab")).toHaveTextContent("Mail cache cleared");

      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(mailMocks.mailSyncFolder).not.toHaveBeenCalled();
      expect(screen.queryByTestId("mail-message-row")).not.toBeInTheDocument();

      mailMocks.mailSyncFolder.mockImplementation(async () => {
        mailMocks.mailListCachedMessages.mockResolvedValue([message]);
        return stepResult({ messages: [message], fetched: 1 });
      });
      act(() => notifyIdle({ payload: { accountId: info.sessionId, kind: "changed" } }));
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(mailMocks.mailSyncFolder).toHaveBeenCalled();
      expect(screen.getByTestId("mail-message-row")).toHaveTextContent(message.subject);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the cache after an active IDLE writer and ignores an older cache page", async () => {
    let finishSync!: (result: MailFolderSyncResult) => void;
    let finishPage!: (page: MailMessageHeader[]) => void;
    mailMocks.mailListCachedMessages.mockImplementationOnce(() => new Promise((resolve) => { finishPage = resolve; }));
    mailMocks.mailSyncFolder.mockImplementationOnce(() => new Promise((resolve) => { finishSync = resolve; }));
    mailMocks.mailClearCache.mockImplementation(async () => {
      mailMocks.mailListCachedFolders.mockResolvedValue([]);
      mailMocks.mailListCachedMessages.mockResolvedValue([]);
    });
    renderMailbox();
    await waitFor(() => expect(finishPage).toBeDefined());

    vi.useFakeTimers();
    try {
      const notifyIdle = eventMocks.handlers.get("mail://idle")!;
      act(() => notifyIdle({ payload: { accountId: info.sessionId, kind: "changed" } }));
      await act(async () => vi.advanceTimersByTimeAsync(400));
      expect(finishSync).toBeDefined();

      fireEvent.click(screen.getByTitle("Clear this account cache"));
      expect(mailMocks.mailClearCache).not.toHaveBeenCalled();
      await act(async () => {
        finishSync(stepResult({ messages: [message], fetched: 1 }));
        await vi.advanceTimersByTimeAsync(150);
      });
      expect(mailMocks.mailClearCache).toHaveBeenCalledOnce();
      expect(screen.getByTestId("mail-client-tab")).toHaveTextContent("Mail cache cleared");

      await act(async () => finishPage([message]));
      expect(screen.queryByTestId("mail-message-row")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  for (const source of ["cache", "server"] as const) {
    it(`retains a folder-read notice when a ${source} body finishes afterward`, async () => {
      let finishBody!: (body: MailMessageBody) => void;
      mailMocks.mailListCachedFolders.mockResolvedValue([{ ...folder, unread: 1 }]);
      mailMocks.mailGetMessageBody.mockImplementationOnce(() => new Promise((resolve) => { finishBody = resolve; }));
      mailMocks.mailMarkRead.mockImplementation(async () => {
        mailMocks.mailListCachedFolders.mockResolvedValue([{ ...folder, unread: 0 }]);
        mailMocks.mailListCachedMessages.mockResolvedValue([{ ...message, flags: ["\\Seen"] }]);
        return { folder: "INBOX", marked: 1 };
      });
      renderMailbox();
      await waitFor(() => expect(finishBody).toBeDefined());
      fireEvent.click(screen.getByTestId("mail-mark-folder-read"));
      await screen.findByText("Marked 1 messages as read");
      await act(async () => finishBody({ ...messageBody, source }));
      await screen.findByText(/Second line stays visible/);
      expect(screen.getByTestId("mail-client-tab")).toHaveTextContent("Marked 1 messages as read");
      expect(screen.getByTestId("mail-message-row")).toHaveAttribute("data-unread", "false");
    });

    it(`retains normal ${source} body loading feedback without a completed operation`, async () => {
      mailMocks.mailGetMessageBody.mockResolvedValue({ ...messageBody, source });
      renderMailbox();
      await screen.findByText(`Loaded body from ${source}`);
      await screen.findByText(/Second line stays visible/);
    });
  }

  it("shows a new manual sync result after a completed folder-read operation", async () => {
    mailMocks.mailListCachedFolders.mockResolvedValue([{ ...folder, unread: 1 }]);
    mailMocks.mailMarkRead.mockResolvedValue({ folder: "INBOX", marked: 1 });
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByTestId("mail-mark-folder-read"));
    await screen.findByText("Marked 1 messages as read");
    fireEvent.click(screen.getByTestId("mail-sync-button"));
    await screen.findByText("Synced 0 new headers across 1 folders");
  });

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

  it("keeps Load older available when a superseded page finishes after a foreground refresh", async () => {
    const headers = Array.from({ length: 120 }, (_, index) => ({ ...message, uid: 120 - index }));
    const complete = { ...folder, total: 120, cachedCount: 120, syncComplete: true };
    let finishOldPage!: (value: MailMessageHeader[]) => void;
    mailMocks.mailListCachedFolders.mockResolvedValue([complete]);
    mailMocks.mailListCachedMessages.mockImplementation(async (_account, _folder, limit, offset) => headers.slice(offset, offset + limit));
    mailMocks.mailSyncAllFolders.mockResolvedValue({
      accountId: info.sessionId, folders: [complete], fetchedMessages: 0,
      newMessages: 0, cachedBodies: 0, syncedAt: 0,
    });
    renderMailbox();
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "50"));
    mailMocks.mailListCachedMessages.mockImplementationOnce(() => new Promise((resolve) => { finishOldPage = resolve; }));
    fireEvent.click(screen.getByTestId("mail-load-more"));
    await waitFor(() => expect(finishOldPage).toBeDefined());
    fireEvent.click(screen.getByTestId("mail-sync-button"));
    await waitFor(() => expect(screen.getByTestId("mail-sync-button")).toBeEnabled());
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-has-more", "true"));
    await act(async () => finishOldPage(headers.slice(50, 101)));
    expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-has-more", "true");
    fireEvent.click(screen.getByTestId("mail-load-more"));
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "100"));
    fireEvent.click(screen.getByTestId("mail-load-more"));
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "120"));
    expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-has-more", "false");
  });

  it("avoids duplicate on-open sync under StrictMode and preserves Loaded body from cache", async () => {
    let finishSync!: (result: MailFolderSyncResult) => void;
    mailMocks.mailSyncFolder.mockImplementation(() => new Promise((resolve) => { finishSync = resolve; }));
    mailMocks.mailGetMessageBody.mockResolvedValue({ ...messageBody, source: "cache" });

    render(
      <StrictMode>
        <MailClientTab tabId="mail-tab" info={{ ...info, sync: { ...info.sync, onOpen: true } }} visible />
      </StrictMode>,
    );

    await waitFor(() => expect(finishSync).toBeDefined());
    expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(1);
    await screen.findByText("Loaded body from cache");
    expect(screen.queryByText("Mail sync already running")).not.toBeInTheDocument();

    await act(async () => finishSync(stepResult({})));
    await waitFor(() => expect(screen.getByTestId("mail-sync-button")).toBeEnabled());
    expect(screen.getByTestId("mail-client-tab")).toHaveTextContent("Loaded body from cache");
    expect(screen.queryByText("Mailbox up to date")).not.toBeInTheDocument();
  });
}
