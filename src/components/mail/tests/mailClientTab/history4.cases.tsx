import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import type { MailFolder, MailFolderSyncResult, MailMessageHeader } from "../../../../lib/mail";
import { useTaoAlertStore } from "../../../../stores/taoAlertStore";
import { MailClientTab } from "../../MailClientTab";
import { eventMocks, folder, info, mailMocks, message, renderMailbox, stepResult } from "./harness";

export function registerMailClientTabHistory4Cases() {

  it("does not restore deleted messages from a late folder-read cache reply", async () => {
    let finishRead!: (value: { folder: string; marked: number; }) => void;
    let finishCache!: (value: MailMessageHeader[]) => void;
    mailMocks.mailListCachedFolders.mockResolvedValue([{ ...folder, unread: 1 }, { ...folder, name: "Trash", flags: ["\\Trash"] }]);
    mailMocks.mailMarkRead.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    mailMocks.mailMoveMessages.mockResolvedValue({ count: 1 });
    renderMailbox();
    await screen.findByTestId("mail-message-row");
    fireEvent.click(screen.getByTestId("mail-mark-folder-read"));
    mailMocks.mailListCachedMessages.mockImplementationOnce(() => new Promise((resolve) => { finishCache = resolve; }));
    await act(async () => finishRead({ folder: "INBOX", marked: 1 }));
    await waitFor(() => expect(finishCache).toBeDefined());
    fireEvent.click(within(screen.getByTestId("mail-message-row")).getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("mail-delete-selected"));
    await waitFor(() => expect(screen.queryByTestId("mail-message-row")).not.toBeInTheDocument());
    // The read query saw this row before the successful move committed.
    await act(async () => finishCache([message]));
    expect(screen.queryByTestId("mail-message-row")).not.toBeInTheDocument();
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("0 selected");
  });

  it("keeps a user's selection when a folder read finishes", async () => {
    let finishRead!: (value: { folder: string; marked: number; }) => void;
    mailMocks.mailListCachedFolders.mockResolvedValue([{ ...folder, unread: 1 }]);
    mailMocks.mailMarkRead.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    renderMailbox();
    await screen.findByTestId("mail-message-row");
    fireEvent.click(screen.getByTestId("mail-mark-folder-read"));
    await waitFor(() => expect(mailMocks.mailMarkRead).toHaveBeenCalled());
    fireEvent.click(within(screen.getByTestId("mail-message-row")).getByRole("checkbox"));
    await act(async () => finishRead({ folder: "INBOX", marked: 1 }));
    await waitFor(() => expect(screen.getByTestId("mail-mark-folder-read")).toBeEnabled());
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("1 selected");
  });

  it("supports checkbox ranges and list-only select-all without stealing search input", async () => {
    mailMocks.mailListCachedMessages.mockResolvedValue(Array.from({ length: 4 }, (_, index) => ({
      ...message, uid: 101 + index, subject: `Select range ${index}`, dateTs: (message.dateTs ?? 0) - index,
    })));
    renderMailbox();
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(4));
    const rows = screen.getAllByTestId("mail-message-row");
    fireEvent.click(within(rows[1]).getByRole("checkbox"));
    fireEvent.click(within(rows[3]).getByRole("checkbox"), { shiftKey: true });
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("3 selected");
    expect(within(rows[0]).getByRole("checkbox")).not.toBeChecked();
    fireEvent.keyDown(rows[0], { key: "a", ctrlKey: true });
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("4 selected");
    fireEvent.keyDown(rows[0], { key: "Escape" });
    fireEvent.keyDown(screen.getByTestId("mail-search-input"), { key: "a", metaKey: true });
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("0 selected");
  });

  it("keeps failed deletions selected and asks before permanently deleting", async () => {
    mailMocks.mailMoveMessages.mockRejectedValue(new Error("IMAP unavailable"));
    mailMocks.mailListCachedFolders.mockResolvedValue([folder, { ...folder, name: "Trash", flags: ["\\Trash"] }]);
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(within(screen.getByTestId("mail-message-row")).getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("mail-delete-selected"));
    expect(await screen.findByText(/IMAP unavailable/)).toBeInTheDocument();
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("1 selected");
    expect(screen.getByTestId("mail-message-row")).toBeInTheDocument();
    cleanup();

    // Without a Trash destination the destructive action needs confirmation.
    mailMocks.mailListCachedFolders.mockResolvedValue([folder]);
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(within(screen.getByTestId("mail-message-row")).getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("mail-delete-selected"));
    expect(await screen.findByText("Delete permanently")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mailMocks.mailDeleteMessages).not.toHaveBeenCalled();
    expect(screen.getByTestId("mail-message-row")).toBeInTheDocument();
  });

  it("retains only unfinished selections when a later deletion batch fails", async () => {
    mailMocks.mailListCachedMessages.mockResolvedValue(Array.from({ length: 251 }, (_, index) => ({
      ...message, uid: 101 + index, dateTs: (message.dateTs ?? 0) - index,
    })));
    mailMocks.mailListCachedFolders.mockResolvedValue([folder, { ...folder, name: "Trash", flags: ["\\Trash"] }]);
    mailMocks.mailMoveMessages.mockResolvedValueOnce({ count: 50 }).mockRejectedValueOnce(new Error("Second batch unavailable"));
    render(<MailClientTab tabId="mail-tab" info={{ ...info, sync: { ...info.sync, maxFetchPerSync: 300 } }} visible />);
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(251));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible messages" }));
    fireEvent.click(screen.getByTestId("mail-delete-selected"));
    expect(await screen.findByText(/Second batch unavailable/)).toBeInTheDocument();
    expect(mailMocks.mailMoveMessages.mock.calls.map((call) => call[2].length)).toEqual([50, 50]);
    expect(screen.getAllByTestId("mail-message-row")).toHaveLength(201);
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("201 selected");
    const failedId = mailMocks.mailMoveMessages.mock.calls[1][4];
    mailMocks.mailMoveMessages.mockResolvedValue({ count: 50 });
    fireEvent.click(screen.getByTestId("mail-mutation-retry"));
    await waitFor(() => expect(screen.queryByTestId("mail-message-row")).not.toBeInTheDocument());
    expect(mailMocks.mailMoveMessages.mock.calls[2][4]).toBe(failedId);
    expect(mailMocks.mailMoveMessages.mock.calls.map((call) => call[2].length)).toEqual([50, 50, 50, 50, 50, 50, 1]);
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("0 selected");
    expect(screen.getByTestId("mail-mutation-progress")).toHaveTextContent("Processed 251/251 messages");
  });

  it("keeps partial mutation recovery visible while the reader loads the next message", async () => {
    mailMocks.mailListCachedMessages.mockResolvedValue([message, { ...message, uid: 102, subject: "Next message" }]);
    mailMocks.mailListCachedFolders.mockResolvedValue([folder, { ...folder, name: "Trash", flags: ["\\Trash"] }]);
    mailMocks.mailMoveMessages.mockResolvedValue({
      count: 1, mutation: {
        operationId: "partial-move", completedUids: [101], pendingUids: [102], uncertainUids: [],
        error: "Retry to continue", detail: "destination unavailable", retryable: true, batchSize: 1,
      }
    });
    renderMailbox();
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(2));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible messages" }));
    fireEvent.click(screen.getByTestId("mail-delete-selected"));
    expect(await screen.findByTestId("mail-mutation-retry")).toBeEnabled();
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(1));
    // Reading can clear the ordinary status/error without erasing the durable action notice.
    fireEvent.click(screen.getByTestId("mail-message-row"));
    await waitFor(() => expect(mailMocks.mailGetMessageBody).toHaveBeenCalledWith(info, "INBOX", 102));
    expect(screen.getByTestId("mail-mutation-retry")).toBeEnabled();
    expect(screen.getByText(/Processed 1\/2 messages\. Retry to continue/)).toBeInTheDocument();
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("1 selected");
  });

  it("runs Thunderbird list shortcuts outside inputs (TASK-22)", async () => {
    const second: MailMessageHeader = { ...message, uid: 102, messageId: "message-102@example.com", subject: "Second", dateTs: (message.dateTs ?? 0) - 60 };
    mailMocks.mailListCachedMessages.mockResolvedValue([message, second]);
    mailMocks.mailSetFlags.mockResolvedValue(undefined);
    renderMailbox();
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(2));
    const rowByUid = (uid: number) =>
      document.querySelector(`[data-testid="mail-message-row"][data-uid="${uid}"]`) as HTMLElement;

    fireEvent.click(rowByUid(101));
    await waitFor(() => expect(rowByUid(101)).toHaveAttribute("aria-pressed", "true"));
    fireEvent.keyDown(rowByUid(101), { key: "f" });
    await waitFor(() => expect(rowByUid(102)).toHaveAttribute("aria-pressed", "true"));
    expect(rowByUid(102)).toHaveAttribute("data-checked", "true");
    expect(rowByUid(101)).toHaveAttribute("data-checked", "false");
    fireEvent.keyDown(rowByUid(102), { key: "b" });
    await waitFor(() => expect(rowByUid(101)).toHaveAttribute("aria-pressed", "true"));

    // Typing in the search box never triggers list shortcuts.
    const search = screen.getByTestId("mail-search-input");
    fireEvent.keyDown(search, { key: "s" });
    expect(mailMocks.mailSetFlags).not.toHaveBeenCalled();
    fireEvent.keyDown(rowByUid(101), { key: "s" });
    await waitFor(() => expect(mailMocks.mailSetFlags).toHaveBeenCalled());

    fireEvent.keyDown(document.body, { key: "K", ctrlKey: true, shiftKey: true });
    expect(document.activeElement).toBe(search);
  });

  it("moves dragged messages onto a folder and copies with Ctrl (TASK-22)", async () => {
    const archive: MailFolder = { ...folder, name: "Archive", displayName: "Archive" };
    mailMocks.mailListCachedFolders.mockResolvedValue([folder, archive]);
    mailMocks.mailMoveMessages.mockResolvedValue(undefined);
    mailMocks.mailCopyMessages.mockResolvedValue(undefined);
    renderMailbox();
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(1));
    const row = screen.getAllByTestId("mail-message-row")[0];
    const target = await waitFor(() => {
      const el = document.querySelector('[data-testid="mail-folder-row"][data-folder-name="Archive"]');
      if (!el) throw new Error("no Archive row");
      return el as HTMLElement;
    });
    const dataTransfer = { types: ["application/x-taomni-mail"], setData: vi.fn(), effectAllowed: "", dropEffect: "" };

    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveAttribute("data-drop-target", "true");
    // jsdom's DragEvent ignores modifier init; set it like a real Ctrl-drop.
    const copyDrop = createEvent.drop(target, { dataTransfer });
    Object.defineProperty(copyDrop, "ctrlKey", { value: true });
    fireEvent(target, copyDrop);
    await waitFor(() => expect(mailMocks.mailCopyMessages).toHaveBeenCalledWith(info, "INBOX", [101], "Archive", expect.any(String)));
    expect(mailMocks.mailMoveMessages).not.toHaveBeenCalled();

    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(mailMocks.mailMoveMessages).toHaveBeenCalledWith(info, "INBOX", [101], "Archive", expect.any(String)));
  });

  it("waits for background sync instead of dropping a manual sync click", async () => {
    let resolveSync: (value: MailFolderSyncResult) => void = () => { };
    mailMocks.mailSyncFolder.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSync = resolve;
    }));
    renderMailbox();
    await waitFor(() => expect(eventMocks.handlers.has("mail://idle")).toBe(true));
    // A push starts a background catch-up that is still running at click time.
    act(() => eventMocks.handlers.get("mail://idle")!({
      payload: { accountId: info.sessionId, folder: "INBOX", kind: "changed" },
    }));
    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(1), { timeout: 3000 });

    fireEvent.click(screen.getByTestId("mail-sync-button"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(mailMocks.mailSyncAllFolders).not.toHaveBeenCalled();

    await act(async () => {
      resolveSync(stepResult({}));
    });
    await waitFor(() => expect(mailMocks.mailSyncAllFolders).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it("finishes every on-open catch-up batch across StrictMode effect replay", async () => {
    mailMocks.mailSyncFolder
      .mockResolvedValueOnce(stepResult({ more: true, remainingNew: 250 }))
      .mockResolvedValueOnce(stepResult({ more: true, remainingNew: 50 }))
      .mockResolvedValueOnce(stepResult({ more: false }));
    const openInfo = { ...info, sync: { ...info.sync, onOpen: true } };
    render(<StrictMode><MailClientTab tabId="mail-tab" info={openInfo} visible /></StrictMode>);
    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(3));
    expect(mailMocks.mailSyncFolder.mock.calls.every(([, name, options]) => name === "INBOX" && options.mode === "auto")).toBe(true);
  });

  it("keeps new-mail alerts when a manual Sync preempts a quiet poll", async () => {
    vi.useFakeTimers();
    let finish: (result: MailFolderSyncResult) => void = () => { };
    mailMocks.mailSyncFolder.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const intervalInfo = { ...info, sync: { ...info.sync, onOpen: false, intervalMinutes: 1 } };
    render(<MailClientTab tabId="mail-tab" info={intervalInfo} visible />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("mail-sync-button"));
    await act(async () => {
      finish(stepResult({ newUnseen: 2 }));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mailMocks.mailSyncAllFolders).toHaveBeenCalledTimes(1);
    expect(useTaoAlertStore.getState().mailNew).toEqual(expect.arrayContaining([
      expect.objectContaining({ count: 2 }),
    ]));
  });

  it("finishes the manual Sync spinner while gap-free pending catch-up continues in background", async () => {
    let finish: (result: MailFolderSyncResult) => void = () => { };
    const base = await mailMocks.mailSyncAllFolders.getMockImplementation()!(info, {});
    mailMocks.mailSyncAllFolders.mockResolvedValue({ ...base, pendingFolders: ["INBOX"] });
    mailMocks.mailSyncFolder.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderMailbox();
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("mail-sync-button"));
    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("mail-sync-button")).not.toBeDisabled());
    // Pending folders are drained in bounded steps, with no lost continuation.
    mailMocks.mailSyncFolder.mockResolvedValueOnce(stepResult({ more: false }));
    await act(async () => finish(stepResult({ more: true, remainingNew: 7 })));
    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(3));
    expect(mailMocks.mailSyncFolder).toHaveBeenLastCalledWith(info, "INBOX", expect.objectContaining({ mode: "reconcileFull" }));
  });
}
