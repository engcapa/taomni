import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { MailDraft, MailFolder, MailFolderSyncResult, MailMessageHeader } from "../../../../lib/mail";
import { useAppStore } from "../../../../stores/appStore";
import type { MailTabInfo } from "../../../../types";
import { MailClientTab } from "../../MailClientTab";
import { calendarMocks, eventMocks, folder, info, mailMocks, message, messageBody, renderMailbox, stepResult } from "./harness";

export interface registerMailClientTabHistory3CasesContext {
  useDraftStore: () => MailDraft[];
  replyAndReach: (testId: string) => Promise<HTMLElement>;
}

export function registerMailClientTabHistory3Cases(caseContext: registerMailClientTabHistory3CasesContext) {

  it("queues Send later in the Outbox and sends it with Send all (TASK-17)", async () => {
    const store = caseContext.useDraftStore();
    mailMocks.mailSendMessage.mockResolvedValue({ accepted: true, response: "ok", sentCopyFolder: "Sent" });
    fireEvent.click(await caseContext.replyAndReach("mail-compose-read-receipt"));
    fireEvent.click(screen.getByTestId("mail-compose-send-later"));
    fireEvent.change(screen.getByTestId("mail-send-later-at"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("mail-send-later-confirm"));

    await waitFor(() => expect(screen.queryByTestId("mail-compose-dialog")).toBeNull());
    expect(store).toHaveLength(1);
    expect(store[0].replyContext?.outbox).toMatchObject({ sendAt: null, attempts: 0, readReceipt: true });
    expect(mailMocks.mailSendMessage).not.toHaveBeenCalled();
    expect(await screen.findByTestId("mail-outbox-count")).toHaveTextContent("1");

    fireEvent.click(screen.getByTestId("mail-drafts-open"));
    fireEvent.click(await screen.findByTestId("mail-drafts-tab-outbox"));
    expect(await screen.findByTestId("mail-outbox-row")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mail-outbox-send-all"));
    await waitFor(() => expect(mailMocks.mailSendMessage).toHaveBeenCalledTimes(1));
    expect(mailMocks.mailSendMessage.mock.calls[0][1]).toMatchObject({ requestReadReceipt: true, draftId: "d1" });
    await waitFor(() => expect(store).toHaveLength(0));
    await waitFor(() => expect(screen.queryByTestId("mail-outbox-count")).toBeNull());
  });

  it("keeps a message in the Outbox when the server is unreachable (AC-49)", async () => {
    const store = caseContext.useDraftStore();
    mailMocks.mailSendMessage.mockRejectedValue(new Error("SMTP connect failed: Connection refused"));
    fireEvent.click(await caseContext.replyAndReach("mail-compose-send"));
    await waitFor(() => expect(screen.queryByTestId("mail-compose-dialog")).toBeNull());
    expect(store[0].replyContext?.outbox).toMatchObject({ attempts: 1 });
    expect(store[0].replyContext?.outbox?.lastError).toMatch(/Connection refused/);
    expect(await screen.findByText(/message is in the Outbox/)).toBeInTheDocument();
  });

  it("undoes a send inside the undo window (AC-50)", async () => {
    const store = caseContext.useDraftStore();
    mailMocks.mailSendMessage.mockResolvedValue({ accepted: true, response: "ok" });
    render(<MailClientTab tabId="mail-tab" info={{ ...info, undoSendSeconds: 30 }} visible />);
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.click(await screen.findByTestId("mail-compose-send"));
    expect(await screen.findByTestId("mail-undo-send")).toHaveTextContent(/Sending in \d+s/);
    expect(store[0].replyContext?.outbox?.sendAt).toBeGreaterThan(Date.now() / 1000);

    fireEvent.click(screen.getByTestId("mail-undo-send-button"));
    expect(await screen.findByTestId("mail-compose-dialog")).toBeInTheDocument();
    await waitFor(() => expect(store[0].replyContext?.outbox).toBeUndefined());
    expect(mailMocks.mailSendMessage).not.toHaveBeenCalled();
  });

  it("unsubscribes by mailto in the composer and one-click after confirm (TASK-18)", async () => {
    const listMail: MailMessageHeader = {
      ...message,
      listUnsubscribe: { uris: ["mailto:leave@lists.example.com?subject=unsubscribe"], oneClick: false },
    };
    mailMocks.mailListCachedMessages.mockResolvedValue([listMail]);
    const view = renderMailbox();
    fireEvent.click(await screen.findByTestId("mail-unsubscribe"));
    expect(await screen.findByTestId("mail-compose-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-subject")).toHaveValue("unsubscribe");
    expect(screen.getByTestId("mail-compose-dialog")).toHaveTextContent("leave@lists.example.com");
    view.unmount();

    const oneClick: MailMessageHeader = {
      ...message,
      listUnsubscribe: { uris: ["https://lists.example.com/u/1"], oneClick: true },
    };
    mailMocks.mailListCachedMessages.mockResolvedValue([oneClick]);
    mailMocks.mailUnsubscribeOneClick.mockResolvedValue(200);
    renderMailbox();
    const button = await screen.findByTestId("mail-unsubscribe");
    fireEvent.click(button);
    expect(mailMocks.mailUnsubscribeOneClick).not.toHaveBeenCalled();
    expect(await screen.findByText("Confirm unsubscribe")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mail-unsubscribe"));
    await waitFor(() => expect(mailMocks.mailUnsubscribeOneClick).toHaveBeenCalledWith("https://lists.example.com/u/1"));
    expect(await screen.findByText(/Unsubscribe request sent/)).toBeInTheDocument();
  });

  it("opens mailto links from a plain-text body in the composer (TASK-18)", async () => {
    mailMocks.mailGetMessageBody.mockResolvedValue({ ...messageBody, html: null, text: "Write to team@example.com today" });
    renderMailbox();
    const link = await waitFor(() => {
      const el = document.querySelector('a[href^="mailto:team@example.com"]');
      if (!el) throw new Error("no mailto link yet");
      return el as HTMLElement;
    });
    fireEvent.click(link);
    expect(await screen.findByTestId("mail-compose-dialog")).toHaveTextContent("team@example.com");
  });

  it("reminds about a missing attachment before sending (TASK-15)", async () => {
    mailMocks.mailSendMessage.mockResolvedValue({ accepted: true, response: "ok" });
    fireEvent.click(await caseContext.replyAndReach("mail-compose-subject"));
    fireEvent.change(screen.getByTestId("mail-compose-subject"), { target: { value: "Report attached" } });
    fireEvent.click(screen.getByTestId("mail-compose-send"));
    expect(await screen.findByTestId("mail-attach-reminder")).toBeInTheDocument();
    expect(mailMocks.mailSendMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("mail-attach-reminder-send"));
    await waitFor(() => expect(mailMocks.mailSendMessage).toHaveBeenCalledTimes(1));
  });

  it("blocks an invalid recipient with a send error dialog", async () => {
    mailMocks.mailSendMessage.mockResolvedValue({ accepted: true, response: "ok" });
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByTestId("mail-compose-open"));
    const recipientInput = within(await screen.findByTestId("mail-recipient-to")).getByRole("textbox");
    fireEvent.change(recipientInput, { target: { value: "not-an-email" } });
    fireEvent.blur(recipientInput);
    fireEvent.click(screen.getByTestId("mail-compose-send"));

    const dialog = await screen.findByTestId("mail-compose-error-dialog");
    expect(dialog).toHaveTextContent("Invalid recipient: not-an-email");
    expect(mailMocks.mailSendMessage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mail-attach-reminder")).toBeNull();
    fireEvent.click(screen.getByTestId("mail-compose-error-ok"));
    expect(screen.queryByTestId("mail-compose-error-dialog")).toBeNull();
  });

  it("shows a calendar invitation and sends the chosen reply (TASK-20)", async () => {
    const invited: MailMessageHeader = {
      ...message,
      hasAttachments: true,
      attachmentCount: 1,
      attachments: [{ name: "invite.ics", contentType: "text/calendar", size: 420 }],
    };
    mailMocks.mailListCachedMessages.mockResolvedValue([invited]);
    mailMocks.mailGetMessageBody.mockResolvedValue({ ...messageBody, attachments: invited.attachments });
    mailMocks.mailGetInvite.mockResolvedValue({
      method: "REQUEST",
      uid: "evt-1",
      sequence: 0,
      summary: "Design review",
      location: "Room 1",
      start: { local: "2026-10-05T10:00", tzid: "China Standard Time", allDay: false },
      end: { local: "2026-10-05T11:00", tzid: "China Standard Time", allDay: false },
      organizer: { email: "boss@example.com", name: "Boss", partstat: "ACCEPTED" },
      attendees: [],
      ics: "",
    });
    mailMocks.mailRespondInvite.mockResolvedValue({ partstat: "TENTATIVE", sentTo: "boss@example.com" });
    renderMailbox();
    const card = await screen.findByTestId("mail-invite-card");
    expect(card).toHaveTextContent("Design review");
    expect(screen.getByTestId("mail-invite-when")).toHaveTextContent("2026-10-05 10:00 – 11:00 (China Standard Time)");
    fireEvent.click(screen.getByTestId("mail-invite-tentative"));
    await waitFor(() => expect(mailMocks.mailRespondInvite).toHaveBeenCalledWith(
      expect.anything(), invited.folder, invited.uid, "tentative",
    ));
    expect(await screen.findByTestId("mail-invite-responded")).toHaveTextContent("tentative");
    expect(screen.getByTestId("mail-invite-card")).toHaveAttribute("data-partstat", "TENTATIVE");
  });

  it("writes an accepted invitation into the CalDAV calendar (AC-64)", async () => {
    const invited: MailMessageHeader = {
      ...message,
      attachments: [{ name: "invite.ics", contentType: "text/calendar", size: 420 }],
    };
    mailMocks.mailListCachedMessages.mockResolvedValue([invited]);
    mailMocks.mailGetMessageBody.mockResolvedValue({ ...messageBody, attachments: invited.attachments });
    mailMocks.mailGetInvite.mockResolvedValue({
      method: "REQUEST",
      uid: "evt-1",
      sequence: 0,
      summary: "Planning",
      organizer: { email: "boss@example.com", partstat: "ACCEPTED" },
      attendees: [],
      ics: "",
    });
    mailMocks.mailRespondInvite.mockResolvedValue({ partstat: "ACCEPTED", sentTo: "boss@example.com" });
    calendarMocks.mailAddInviteToCalendar.mockResolvedValue({ href: "/cal/evt-1.ics", created: true });
    render(<MailClientTab tabId="mail-tab" info={{ ...info, caldav: { url: "https://dav.example/" } }} visible />);
    fireEvent.click(await screen.findByTestId("mail-invite-accept"));
    await waitFor(() => expect(calendarMocks.mailAddInviteToCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: info.sessionId }), invited.folder, invited.uid, "ACCEPTED",
    ));
    expect(await screen.findByTestId("mail-invite-in-calendar")).toBeInTheDocument();
    expect(screen.queryByTestId("mail-invite-add-calendar")).not.toBeInTheDocument();
    expect(screen.getByTestId("mail-agenda-open")).toBeInTheDocument();
  });

  it("asks before sending a read receipt and only once (TASK-17)", async () => {
    const asking: MailMessageHeader = { ...message, receiptTo: "boss@example.com" };
    mailMocks.mailListCachedMessages.mockResolvedValue([asking]);
    mailMocks.mailSendReceipt.mockResolvedValue({ sentTo: "boss@example.com" });
    renderMailbox();
    expect(await screen.findByTestId("mail-receipt-banner")).toHaveTextContent("boss@example.com");
    expect(mailMocks.mailSendReceipt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("mail-receipt-send"));
    await waitFor(() => expect(mailMocks.mailSendReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: info.sessionId }), asking.folder, asking.uid, false,
    ));
    await waitFor(() => expect(screen.queryByTestId("mail-receipt-banner")).not.toBeInTheDocument());
    expect(await screen.findByText(/Read receipt sent to boss@example.com/)).toBeInTheDocument();
  });

  it("follows the always and never receipt policies (TASK-17)", async () => {
    const asking: MailMessageHeader = { ...message, receiptTo: "boss@example.com" };
    mailMocks.mailListCachedMessages.mockResolvedValue([asking]);
    mailMocks.mailSendReceipt.mockResolvedValue({ sentTo: "boss@example.com" });
    const view = render(<MailClientTab tabId="mail-tab" info={{ ...info, receiptPolicy: "always" }} visible />);
    await waitFor(() => expect(mailMocks.mailSendReceipt).toHaveBeenCalledWith(
      expect.anything(), asking.folder, asking.uid, true,
    ));
    expect(screen.queryByTestId("mail-receipt-banner")).not.toBeInTheDocument();
    view.unmount();

    mailMocks.mailSendReceipt.mockClear();
    render(<MailClientTab tabId="mail-tab" info={{ ...info, receiptPolicy: "never" }} visible />);
    await screen.findByText(message.subject);
    expect(screen.queryByTestId("mail-receipt-banner")).not.toBeInTheDocument();
    expect(mailMocks.mailSendReceipt).not.toHaveBeenCalled();
  });

  it("shows a cancelled meeting without reply buttons (AC-63)", async () => {
    const cancelled: MailMessageHeader = {
      ...message,
      attachments: [{ name: "cancel.ics", contentType: "text/calendar", size: 300 }],
    };
    mailMocks.mailListCachedMessages.mockResolvedValue([cancelled]);
    mailMocks.mailGetMessageBody.mockResolvedValue({ ...messageBody, attachments: cancelled.attachments });
    mailMocks.mailGetInvite.mockResolvedValue({
      method: "CANCEL",
      uid: "evt-1",
      sequence: 1,
      summary: "Design review",
      status: "CANCELLED",
      organizer: { email: "boss@example.com", partstat: "ACCEPTED" },
      attendees: [],
      ics: "",
    });
    renderMailbox();
    expect(await screen.findByTestId("mail-invite-summary")).toHaveTextContent("Cancelled: Design review");
    expect(screen.queryByTestId("mail-invite-accept")).not.toBeInTheDocument();
    expect(screen.getByTestId("mail-invite-export")).toBeInTheDocument();
  });

  it("downloads a large message's attachment by its IMAP section (TASK-15)", async () => {
    const large: MailMessageHeader = {
      ...message,
      hasAttachments: true,
      attachmentCount: 1,
      attachments: [{ name: "big.pdf", contentType: "application/pdf", size: 31_457_280, section: "2" }],
    };
    mailMocks.mailListCachedMessages.mockResolvedValue([large]);
    mailMocks.mailGetMessageBody.mockResolvedValue({ ...messageBody, attachments: large.attachments });
    mailMocks.mailDownloadAttachment.mockResolvedValue({ path: "/tmp/big.pdf", name: "big.pdf", contentType: "application/pdf", size: 3 });
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    const chip = await screen.findByTitle(/big\.pdf/);
    fireEvent.doubleClick(chip);
    await waitFor(() => expect(mailMocks.mailDownloadAttachment).toHaveBeenCalled());
    expect(mailMocks.mailDownloadAttachment.mock.calls[0][5]).toBe("2");
  });

  it("reviews and trusts a self-signed server certificate (AC-44)", async () => {
    mailMocks.mailSyncAllFolders.mockRejectedValueOnce(
      new Error("IMAP TLS handshake failed: self signed certificate (untrusted server certificate; review it to add an exception)"),
    );
    mailMocks.mailProbeCertificate.mockResolvedValue({
      host: "imap.example.com", port: 993, sha256: "AA:BB", subject: "CN=imap.example.com",
      issuer: "CN=imap.example.com", notBefore: "2026", notAfter: "2036", derBase64: "MIIB",
      trustedBySystem: false, verifyError: "self signed certificate",
    });
    useAppStore.setState({ tabs: [{ id: "mail-tab", type: "mail", title: "Mail", mail: info } as never] });
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByTestId("mail-sync-button"));
    fireEvent.click(await screen.findByTestId("mail-cert-review"));
    expect(await screen.findByTestId("mail-cert-fingerprint")).toHaveTextContent("AA:BB");
    expect(mailMocks.mailProbeCertificate).toHaveBeenCalledWith(info, "imap");
    fireEvent.click(screen.getByTestId("mail-cert-trust"));
    await waitFor(() => {
      const tab = useAppStore.getState().tabs.find((entry) => entry.id === "mail-tab") as { mail?: MailTabInfo; } | undefined;
      expect(tab?.mail?.imap.trustedCert).toBe("MIIB");
    });
    expect(screen.queryByTestId("mail-cert-dialog")).toBeNull();
  });

  it("saves a template and starts a new message from it (AC-30)", async () => {
    const template = {
      id: "tpl-1",
      accountId: info.sessionId,
      to: ["team@example.com"],
      cc: [],
      bcc: [],
      subject: "Weekly status",
      textBody: "Status body",
      htmlBody: "<p>Status body</p>",
      attachments: [],
      replyContext: { kind: "template" },
      createdAt: 1,
      updatedAt: 1,
    };
    mailMocks.mailSaveDraft.mockResolvedValue(template);
    mailMocks.mailListDrafts.mockResolvedValue([template]);

    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByTestId("mail-compose-open"));
    fireEvent.change(await screen.findByTestId("mail-compose-subject"), { target: { value: "Weekly status" } });
    fireEvent.click(screen.getByTestId("mail-compose-save-template"));
    await waitFor(() => expect(mailMocks.mailSaveDraft).toHaveBeenCalledWith(
      info.sessionId,
      expect.objectContaining({ id: null, replyContext: expect.objectContaining({ kind: "template" }) }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    fireEvent.click(screen.getByTestId("mail-drafts-open"));
    fireEvent.click(await screen.findByTestId("mail-drafts-tab-templates"));
    fireEvent.click(within(await screen.findByTestId("mail-template-row")).getByText("Weekly status"));
    expect(await screen.findByTestId("mail-compose-subject")).toHaveValue("Weekly status");
  });

  it("skips overlapping periodic sync ticks while a sync is still running", async () => {
    vi.useFakeTimers();
    const intervalInfo: MailTabInfo = {
      ...info,
      sync: { ...info.sync, onOpen: false, intervalMinutes: 1 },
    };
    let resolveSync!: (value: MailFolderSyncResult) => void;
    mailMocks.mailSyncFolder.mockReturnValue(new Promise((resolve) => {
      resolveSync = resolve;
    }));

    render(<MailClientTab tabId="mail-tab" info={intervalInfo} visible={false} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(1);

    mailMocks.mailSyncFolder.mockResolvedValue(stepResult({}));
    await act(async () => {
      resolveSync(stepResult({}));
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    const afterFirst = mailMocks.mailSyncFolder.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mailMocks.mailSyncFolder.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("syncs the newly selected folder after an in-flight INBOX refresh finishes", async () => {
    const trash = { ...folder, name: "Trash", flags: ["\\Trash"], total: 1 };
    const moved = { ...message, folder: "Trash", subject: "Moved to trash" };
    let finishInbox!: (value: MailFolderSyncResult) => void;
    let trashSynced = false;
    mailMocks.mailListCachedFolders.mockResolvedValue([folder, trash]);
    mailMocks.mailListCachedMessages.mockImplementation(async (_id, name) => name === "Trash" ? (trashSynced ? [moved] : []) : [message]);
    mailMocks.mailSyncFolder.mockImplementation(async (_info, name) => {
      if (name === "Trash") {
        trashSynced = true;
        return stepResult({ folder: trash, messages: [moved], fetched: 1 });
      }
      return stepResult({});
    });
    mailMocks.mailSyncFolder.mockImplementationOnce(() => new Promise((resolve) => { finishInbox = resolve; }));
    render(<MailClientTab tabId="mail-tab" info={{ ...info, sync: { ...info.sync, onOpen: true } }} visible />);
    await waitFor(() => expect(finishInbox).toBeTypeOf("function"));
    await waitFor(() => expect(document.querySelector('[data-testid="mail-folder-row"][data-folder-name="Trash"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-testid="mail-folder-row"][data-folder-name="Trash"]')!);
    await waitFor(() => expect(mailMocks.mailListCachedMessages).toHaveBeenCalledWith(info.sessionId, "Trash", expect.any(Number), 0));
    await act(async () => finishInbox(stepResult({})));
    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalledWith(expect.anything(), "Trash", expect.anything()), { timeout: 2500 });
    await waitFor(() => expect(screen.getByTestId("mail-message-row")).toHaveTextContent("Moved to trash"));
  });

  it("does not replace the selected folder with a late cache reply from the previous folder", async () => {
    const trash = { ...folder, name: "Trash", flags: ["\\Trash"] };
    const moved = { ...message, folder: "Trash", subject: "Moved to trash" };
    let finishOldCache!: (value: MailMessageHeader[]) => void;
    mailMocks.mailSyncAllFolders.mockResolvedValue({ folders: [folder, trash], fetchedMessages: 0, pendingFolders: [] });
    mailMocks.mailListCachedFolders.mockResolvedValue([folder, trash]);
    mailMocks.mailListCachedMessages.mockImplementation(async (_id, name) => name === "Trash" ? [moved] : [message]);
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    mailMocks.mailListCachedMessages.mockImplementationOnce(() => new Promise((resolve) => { finishOldCache = resolve; }));
    fireEvent.click(screen.getByTestId("mail-sync-button"));
    await waitFor(() => expect(finishOldCache).toBeTypeOf("function"));
    fireEvent.click(document.querySelector('[data-testid="mail-folder-row"][data-folder-name="Trash"]')!);
    await waitFor(() => expect(screen.getByTestId("mail-message-row")).toHaveTextContent("Moved to trash"));
    await act(async () => finishOldCache([message]));
    expect(screen.getByTestId("mail-message-row")).toHaveTextContent("Moved to trash");
  });

  it("holds an IDLE watcher while open and catches up on push (TASK-12)", async () => {
    const view = renderMailbox();
    await waitFor(() => expect(mailMocks.mailIdleStart).toHaveBeenCalledWith(info, "INBOX"));
    await waitFor(() => expect(eventMocks.handlers.has("mail://idle")).toBe(true));
    const before = mailMocks.mailSyncFolder.mock.calls.length;

    const push = eventMocks.handlers.get("mail://idle")!;
    act(() => push({ payload: { accountId: "someone-else", folder: "INBOX", kind: "changed" } }));
    act(() => push({ payload: { accountId: info.sessionId, folder: "INBOX", kind: "ready" } }));
    expect(await screen.findByTestId("mail-idle-status")).toHaveAttribute("data-active", "true");
    act(() => push({ payload: { accountId: info.sessionId, folder: "INBOX", kind: "changed" } }));
    await waitFor(() => expect(mailMocks.mailSyncFolder.mock.calls.length).toBeGreaterThan(before), { timeout: 3000 });

    view.unmount();
    expect(mailMocks.mailIdleStop).toHaveBeenCalledWith(info.sessionId);
    expect(eventMocks.handlers.has("mail://idle")).toBe(false);
  });

  it("manages folder subscriptions and hides unsubscribed folders (TASK-10)", async () => {
    window.localStorage.clear();
    const inbox: MailFolder = { ...folder, flags: ["\\Subscribed"] };
    const work: MailFolder = { ...folder, name: "Work", displayName: "Work", flags: ["\\Subscribed"] };
    const old: MailFolder = { ...folder, name: "Old", displayName: "Old", flags: [] };
    mailMocks.mailListCachedFolders.mockResolvedValue([inbox, work, old]);
    mailMocks.mailSetFolderSubscription.mockResolvedValue([inbox, work, { ...old, flags: ["\\Subscribed"] }]);
    renderMailbox();
    const folderRow = (name: string) =>
      document.querySelector(`[data-testid="mail-folder-row"][data-folder-name="${name}"]`);
    await waitFor(() => expect(folderRow("Old")).not.toBeNull());

    fireEvent.click(screen.getByTestId("mail-subscriptions-open"));
    fireEvent.click(await screen.findByTestId("mail-subscribed-only"));
    await waitFor(() => expect(folderRow("Old")).toBeNull());
    expect(folderRow("Work")).not.toBeNull();
    expect(window.localStorage.getItem(`taomni.mail.subscribedOnly:${info.sessionId}`)).toBe("true");

    const oldRow = document.querySelector('[data-testid="mail-subscription-row"][data-folder-name="Old"]') as HTMLElement;
    fireEvent.click(within(oldRow).getByTestId("mail-subscription-toggle"));
    await waitFor(() => expect(mailMocks.mailSetFolderSubscription).toHaveBeenCalledWith(info, "Old", true));
    await waitFor(() => expect(folderRow("Old")).not.toBeNull());
    window.localStorage.clear();
  });

  it("selects rows with Ctrl/Cmd and Shift and deletes the selected messages to Trash", async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      ...message, uid: 101 + index, subject: `Selection ${index + 1}`, dateTs: (message.dateTs ?? 0) - index,
    }));
    mailMocks.mailListCachedFolders.mockResolvedValue([folder, { ...folder, name: "Trash", flags: ["\\Trash"] }]);
    mailMocks.mailListCachedMessages.mockResolvedValue(rows);
    mailMocks.mailMoveMessages.mockResolvedValue({ count: 3 });
    renderMailbox();
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(4));
    const rendered = screen.getAllByTestId("mail-message-row");
    fireEvent.click(rendered[0]);
    fireEvent.click(rendered[1], { ctrlKey: true });
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("2 selected");
    fireEvent.click(rendered[2], { shiftKey: true });
    expect(screen.getByTestId("mail-selection-count")).toHaveTextContent("3 selected");
    fireEvent.click(rendered[1], { metaKey: true });
    expect(within(rendered[1]).getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(within(rendered[1]).getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("mail-delete-selected"));
    await waitFor(() => expect(mailMocks.mailMoveMessages).toHaveBeenCalledWith(info, "INBOX", [101, 102, 103], "Trash", expect.any(String)));
    await waitFor(() => expect(screen.getAllByTestId("mail-message-row")).toHaveLength(1));
    expect(screen.getAllByTestId("mail-message-row")[0]).toHaveAttribute("data-uid", "104");
    expect(mailMocks.mailDeleteMessages).not.toHaveBeenCalled();
    expect(screen.getByTestId("mail-delete-selected")).toBeDisabled();
  });

  it("allows deleting a new selection while a folder read is pending", async () => {
    let finishRead!: (value: { folder: string; marked: number; }) => void;
    mailMocks.mailMarkRead.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    mailMocks.mailListCachedFolders.mockResolvedValue([{ ...folder, unread: 1 }, { ...folder, name: "Trash", flags: ["\\Trash"] }]);
    mailMocks.mailMoveMessages.mockResolvedValue({ count: 1 });
    renderMailbox();
    await screen.findByTestId("mail-message-row");
    fireEvent.click(screen.getByTestId("mail-mark-folder-read"));
    await waitFor(() => expect(mailMocks.mailMarkRead).toHaveBeenCalledWith(info, "INBOX", [], true));
    fireEvent.click(within(screen.getByTestId("mail-message-row")).getByRole("checkbox"));
    expect(screen.getByTestId("mail-delete-selected")).toBeEnabled();
    fireEvent.click(screen.getByTestId("mail-delete-selected"));
    await waitFor(() => expect(mailMocks.mailMoveMessages).toHaveBeenCalledWith(info, "INBOX", [101], "Trash", expect.any(String)));
    mailMocks.mailListCachedMessages.mockResolvedValue([]);
    await act(async () => finishRead({ folder: "INBOX", marked: 1 }));
    await waitFor(() => expect(screen.queryByTestId("mail-message-row")).not.toBeInTheDocument());
  });
}
