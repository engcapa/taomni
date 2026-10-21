import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { MailDraft, MailFolder, MailFolderSyncResult, MailMessageHeader } from "../../../../lib/mail";
import { useTaoAlertStore } from "../../../../stores/taoAlertStore";
import type { MailTabInfo } from "../../../../types";
import { MailClientTab } from "../../MailClientTab";
import { eventMocks, folder, info, mailMocks, message, messageBody, renderMailbox, stepResult, uncachedMessage } from "./harness";

export interface registerMailClientTabClipboard2CasesContext {
  useDraftStore: () => MailDraft[];
}

export function registerMailClientTabClipboard2Cases(caseContext: registerMailClientTabClipboard2CasesContext) {

  it("does not overwrite the message list when the folder changes mid quiet poll", async () => {
    vi.useFakeTimers();
    const intervalInfo: MailTabInfo = {
      ...info,
      sync: { ...info.sync, onOpen: false, intervalMinutes: 1 },
    };
    const sentFolder: MailFolder = {
      ...folder,
      name: "Sent",
      displayName: "Sent",
      total: 1,
      unread: 0,
    };
    const sentMessage: MailMessageHeader = {
      ...message,
      folder: "Sent",
      uid: 201,
      subject: "Sent item",
      snippet: "Quiet poll should not force this after leaving Sent",
    };
    const inboxOnlyMessage: MailMessageHeader = {
      ...message,
      uid: 301,
      subject: "Inbox after switch",
      snippet: "Stays visible after mid-poll switch",
    };
    mailMocks.mailListCachedFolders.mockResolvedValue([folder, sentFolder]);
    mailMocks.mailListCachedMessages.mockImplementation(async (_id: string, folderName: string) => {
      if (folderName === "Sent") return [sentMessage];
      return [inboxOnlyMessage];
    });

    let resolveSent: ((value: MailFolderSyncResult) => void) | null = null;
    let holdSent = false;
    mailMocks.mailSyncFolder.mockImplementation((_config: MailTabInfo, folderName: string) => {
      if (folderName === "Sent" && holdSent) {
        return new Promise((resolve) => {
          resolveSent = resolve;
        });
      }
      return Promise.resolve(stepResult({ folder: folderName === "Sent" ? sentFolder : folder }));
    });

    render(<MailClientTab tabId="mail-tab" info={intervalInfo} visible />);
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    fireEvent.click(screen.getByText("Sent"));
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(screen.getAllByText(/Quiet poll should not force this after leaving Sent/).length).toBeGreaterThan(0);

    // Start quiet poll for Sent (in-flight).
    holdSent = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(mailMocks.mailSyncFolder).toHaveBeenCalledWith(
      intervalInfo,
      "Sent",
      { mode: "auto", limit: 50, includeBodies: false },
    );
    expect(resolveSent).not.toBeNull();

    // Switch to INBOX while the Sent poll is still awaiting.
    fireEvent.click(screen.getByText("Inbox"));
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(screen.getAllByText(/Stays visible after mid-poll switch/).length).toBeGreaterThan(0);

    // Complete the stale Sent poll; messages must stay on INBOX.
    await act(async () => {
      resolveSent!(stepResult({
        folder: sentFolder,
        messages: [{ ...sentMessage, subject: "Stale Sent overwrite", snippet: "Must not appear" }],
        fetched: 1,
      }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(screen.getAllByText(/Stays visible after mid-poll switch/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Must not appear/)).toBeNull();
  });

  it("quiet-polls selected folder plus INBOX when selected is not INBOX", async () => {
    vi.useFakeTimers();
    const intervalInfo: MailTabInfo = {
      ...info,
      sync: { ...info.sync, onOpen: false, intervalMinutes: 1 },
    };
    const sentFolder: MailFolder = {
      ...folder,
      name: "Sent",
      displayName: "Sent",
      total: 3,
      unread: 0,
    };
    mailMocks.mailListCachedFolders.mockResolvedValue([folder, sentFolder]);
    mailMocks.mailListCachedMessages.mockImplementation(async (_accountId: string, folderName: string) => {
      if (folderName === "Sent") {
        return [{ ...message, folder: "Sent", uid: 201, subject: "Sent item" }];
      }
      return [message];
    });
    mailMocks.mailSyncFolder.mockImplementation(async (_config: MailTabInfo, folderName: string) =>
      stepResult({ folder: folderName === "Sent" ? sentFolder : folder }));

    render(<MailClientTab tabId="mail-tab" info={intervalInfo} visible />);
    // Flush async cache load under fake timers (avoid waitFor real-time hangs).
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(screen.getByText("Sent")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Sent"));
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(mailMocks.mailListCachedMessages).toHaveBeenCalledWith(
      info.sessionId,
      "Sent",
      51,
      0,
    );
    mailMocks.mailSyncFolder.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const calls = mailMocks.mailSyncFolder.mock.calls.map(([, name, options]) => `${name}:${options.mode}`);
    expect(calls).toEqual(["Sent:auto", "INBOX:auto", "Sent:reconcile"]);
    expect(mailMocks.mailSyncAllFolders).not.toHaveBeenCalled();
  });

  it("pushes a Tao mail notification when periodic full-folder sync reports new messages", async () => {
    vi.useFakeTimers();
    const intervalInfo: MailTabInfo = {
      ...info,
      sync: { ...info.sync, onOpen: false, intervalMinutes: 1 },
    };
    const sentFolder: MailFolder = { ...folder, name: "Sent", displayName: "Sent" };
    mailMocks.mailSyncFolder.mockResolvedValue(stepResult({}));
    mailMocks.mailSyncAllFolders.mockResolvedValue({
      accountId: info.sessionId,
      folders: [folder, sentFolder],
      fetchedMessages: 5,
      newMessages: 5,
      newUnseenByFolder: { INBOX: 2, Sent: 3 },
      failedFolders: [],
      pendingFolders: [],
      cachedBodies: 0,
      syncedAt: 2,
    });

    render(<MailClientTab tabId="mail-tab" info={intervalInfo} visible={false} />);

    // Full-folder scan runs every 6th quiet tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60_000);
    });

    expect(mailMocks.mailSyncAllFolders).toHaveBeenCalledWith(
      { ...intervalInfo, sync: { ...intervalInfo.sync, subscribedOnly: false } },
      { limit: 50, includeBodies: false, fullReconcile: false },
    );
    // Sent is excluded from new-mail alerts.
    expect(useTaoAlertStore.getState().mailNew).toMatchObject([
      {
        id: "mail:mail-tab",
        source: "mail",
        kind: "mail_new",
        title: "Me",
        count: 2,
        mailTabId: "mail-tab",
        mailAccountId: info.sessionId,
      },
    ]);
  });

  it("marks folders whose sync failed and reports the failure count (AC-10)", async () => {
    const brokenFolder: MailFolder = { ...folder, name: "Archive", displayName: "Archive", lastError: "EXAMINE denied" };
    mailMocks.mailSyncAllFolders.mockResolvedValue({
      accountId: info.sessionId,
      folders: [folder, brokenFolder],
      fetchedMessages: 0,
      newMessages: 0,
      failedFolders: [{ name: "Archive", error: "EXAMINE denied" }],
      pendingFolders: [],
      cachedBodies: 0,
      syncedAt: 2,
    });

    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByTestId("mail-sync-button"));

    expect(await screen.findByText(/1 folder failed/)).toBeInTheDocument();
    const errorBadge = await screen.findByTestId("mail-folder-sync-error");
    expect(errorBadge).toHaveAttribute("title", "Sync failed: EXAMINE denied");
  });

  it("backfills older history from the server once the cache is exhausted (AC-07)", async () => {
    const partialFolder: MailFolder = { ...folder, total: 3, cachedCount: 1, syncLowUid: 101, syncHighUid: 101, syncComplete: false };
    const older: MailMessageHeader = { ...uncachedMessage, uid: 50, dateTs: 1700000000, subject: "Older history" };
    mailMocks.mailListCachedFolders.mockResolvedValue([partialFolder]);
    let backfilled = false;
    mailMocks.mailListCachedMessages.mockImplementation(async (_id: string, _folder: string, _limit: number, offset: number) => {
      if (offset === 0) return [message];
      return backfilled ? [older] : [];
    });
    mailMocks.mailSyncFolder.mockImplementation(async (_config: MailTabInfo, _name: string, options: { mode: string; }) => {
      if (options.mode === "backfill") {
        backfilled = true;
        return stepResult({ mode: "backfill", folder: { ...partialFolder, cachedCount: 2, syncLowUid: 50 }, messages: [older], fetched: 1, more: true });
      }
      return stepResult({ folder: partialFolder });
    });

    renderMailbox();
    const loadMore = await screen.findByTestId("mail-load-more");
    fireEvent.click(loadMore);

    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalledWith(
      info,
      "INBOX",
      { mode: "backfill", limit: 50 },
    ));
    expect(await screen.findByText("Older history")).toBeInTheDocument();
  });

  it("groups a reply chain into one expandable conversation (AC-24)", async () => {
    const chain: MailMessageHeader[] = [
      { ...message, uid: 1, messageId: "a@x", subject: "Plan", dateTs: 1, snippet: "first" },
      { ...message, uid: 2, messageId: "b@x", subject: "Re: Plan", dateTs: 2, inReplyTo: "a@x", references: ["a@x"], snippet: "second" },
      { ...message, uid: 3, messageId: "c@x", subject: "Re: Plan", dateTs: 3, inReplyTo: "b@x", references: ["a@x", "b@x"], snippet: "third" },
    ];
    mailMocks.mailListCachedMessages.mockResolvedValue(chain);
    window.localStorage.removeItem("taomni.mail.threadView");

    renderMailbox();
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(3));
    fireEvent.click(screen.getByTestId("mail-thread-view-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(1));
    expect(screen.getByTestId("mail-thread-size")).toHaveTextContent("3");
    fireEvent.click(screen.getByTestId("mail-thread-expand"));
    const rows = screen.getAllByTestId("mail-message-row");
    expect(rows.map((row) => row.getAttribute("data-thread-depth"))).toEqual(["0", "1", "2"]);
    window.localStorage.removeItem("taomni.mail.threadView");
  });

  it("sends reply threading headers and reports the Sent copy (AC-20/AC-23)", async () => {
    const parent: MailMessageHeader = { ...message, messageId: "parent@x", references: ["root@x"], inReplyTo: "root@x" };
    mailMocks.mailListCachedMessages.mockResolvedValue([parent]);
    mailMocks.mailGetMessageBody.mockResolvedValue({ ...messageBody, messageId: "parent@x" });
    mailMocks.mailSendMessage.mockResolvedValue({ accepted: true, response: "ok", sentCopyFolder: "Sent" });

    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByTestId("mail-compose-dialog");
    fireEvent.click(screen.getByTestId("mail-compose-send"));

    await waitFor(() => expect(mailMocks.mailSendMessage).toHaveBeenCalled());
    const request = mailMocks.mailSendMessage.mock.calls[0][1];
    expect(request.inReplyTo).toBe("parent@x");
    expect(request.references).toEqual(["root@x"]);
    expect(await screen.findByText(/copy saved to Sent/)).toBeInTheDocument();
  });

  it.each(["before", "after"])("retains the Sent copy result when its event arrives %s SMTP completion", async (order) => {
    let accept!: (result: { accepted: boolean; response: string; }) => void;
    mailMocks.mailSendMessage.mockReturnValue(new Promise((resolve) => { accept = resolve; }));
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByTestId("mail-compose-dialog");
    fireEvent.click(screen.getByTestId("mail-compose-send"));
    await waitFor(() => expect(mailMocks.mailSendMessage).toHaveBeenCalledTimes(1));
    const copySaved = () => act(() => eventMocks.handlers.get("mail-sent-copy")?.({
      payload: { accountId: info.sessionId, folder: "Sent" },
    }));
    if (order === "before") copySaved();
    await act(async () => accept({ accepted: true, response: "accepted" }));
    if (order === "after") copySaved();
    expect(screen.queryByTestId("mail-compose-dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/copy saved to Sent/)).toBeInTheDocument();
  });

  it("confirms SMTP acceptance before draft cleanup and reports asynchronous copy failures", async () => {
    caseContext.useDraftStore();
    let finishCleanup!: () => void;
    mailMocks.mailDeleteDraft.mockReturnValue(new Promise<void>((resolve) => { finishCleanup = resolve; }));
    mailMocks.mailSendMessage.mockResolvedValue({ accepted: true, response: "accepted" });
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByTestId("mail-compose-dialog");
    fireEvent.click(screen.getByTestId("mail-compose-save-draft"));
    await waitFor(() => expect(mailMocks.mailSaveDraft).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("mail-compose-save-draft")).toBeEnabled());
    fireEvent.click(screen.getByTestId("mail-compose-send"));
    expect(await screen.findByText("Message sent")).toBeInTheDocument();
    expect(screen.queryByTestId("mail-compose-dialog")).not.toBeInTheDocument();
    expect(mailMocks.mailDeleteDraft).toHaveBeenCalledWith(info.sessionId, "d1");
    act(() => eventMocks.handlers.get("mail-sent-copy")?.({
      payload: { accountId: "another-account", error: "unrelated failure" },
    }));
    expect(screen.queryByText(/unrelated failure/)).not.toBeInTheDocument();
    act(() => eventMocks.handlers.get("mail-sent-copy")?.({
      payload: { accountId: info.sessionId, error: "Sent folder unavailable" },
    }));
    expect(screen.getByText("Message sent, but saving the Sent copy failed: Sent folder unavailable")).toBeInTheDocument();
    expect(mailMocks.mailSendMessage).toHaveBeenCalledTimes(1);
    finishCleanup();
  });

  it("searches the whole local index and server, and bulk actions include search-only rows", async () => {
    const hit: MailMessageHeader = { ...uncachedMessage, uid: 7, folder: "Archive", subject: "Budget from archive" };
    const serverHit: MailMessageHeader = { ...uncachedMessage, uid: 8, subject: "Budget only on server" };
    mailMocks.mailSearchMessages.mockResolvedValue([hit]);
    mailMocks.mailSearchServer.mockResolvedValue([serverHit]);
    mailMocks.mailListCachedFolders.mockResolvedValue([folder, { ...folder, name: "Trash", flags: ["\\Trash"] }]);

    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.change(screen.getByTestId("mail-search-scope"), { target: { value: "all" } });
    fireEvent.change(screen.getByTestId("mail-search-input"), { target: { value: "budget" } });

    expect(await screen.findByText("Budget from archive")).toBeInTheDocument();
    expect(mailMocks.mailSearchMessages).toHaveBeenLastCalledWith(info.sessionId, expect.objectContaining({
      text: "budget",
      folder: null,
      field: "all",
    }));
    expect(screen.getByTestId("mail-message-folder")).toHaveTextContent("Archive");

    fireEvent.click(screen.getByTestId("mail-search-server"));
    expect(await screen.findByText("Budget only on server")).toBeInTheDocument();
    expect(mailMocks.mailSearchServer).toHaveBeenCalledWith(info, "INBOX", expect.objectContaining({ text: "budget" }));

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible messages" }));
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("2 selected");
    fireEvent.keyDown(screen.getAllByTestId("mail-message-row")[0], { key: "s" });
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row").every((row) => row.dataset.flagged === "true")).toBe(true));
    fireEvent.click(screen.getByTestId("mail-delete-selected"));
    await waitFor(() => expect(mailMocks.mailMoveMessages).toHaveBeenCalledWith(info, "Archive", [7], "Trash", expect.any(String)));
    expect(mailMocks.mailMoveMessages).toHaveBeenCalledWith(info, "INBOX", [8], "Trash", expect.any(String));
    await waitFor(() => expect(screen.queryAllByTestId("mail-message-row")).toHaveLength(0));
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("0 selected");
  });

  it("quick filters narrow the list to unread messages", async () => {
    mailMocks.mailListCachedMessages.mockResolvedValue([message, { ...uncachedMessage, flags: [] }]);
    renderMailbox();
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(2));
    fireEvent.click(screen.getByTestId("mail-quick-filter-unread"));
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(1));
    expect(screen.getByTestId("mail-message-row")).toHaveAttribute("data-unread", "true");
  });

  it("replies from the alias the message was addressed to (AC-28/AC-29)", async () => {
    const aliasInfo: MailTabInfo = {
      ...info,
      identities: [{ id: "alias", name: "Support", email: "support@example.com", replyTo: "help@example.com", signature: "Support team" }],
    };
    mailMocks.mailListCachedMessages.mockResolvedValue([{ ...message, to: [{ address: "support@example.com" }] }]);
    mailMocks.mailSendMessage.mockResolvedValue({ accepted: true, response: "ok" });

    render(<MailClientTab tabId="mail-tab" info={aliasInfo} visible />);
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const from = await screen.findByTestId("mail-compose-from");
    expect(from).toHaveValue("alias");
    fireEvent.click(screen.getByTestId("mail-compose-send"));
    await waitFor(() => expect(mailMocks.mailSendMessage).toHaveBeenCalled());
    expect(mailMocks.mailSendMessage.mock.calls[0][1]).toMatchObject({
      from: "Support <support@example.com>",
      replyTo: "help@example.com",
    });
  });
}
