import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { MailFolder, MailFolderSyncResult, MailMessageHeader } from "../../../../lib/mail";
import { DEFAULT_TERMINAL_PROFILE } from "../../../../lib/terminalProfile";
import { useTaoAlertStore } from "../../../../stores/taoAlertStore";
import type { MailTabInfo } from "../../../../types";
import { MailClientTab } from "../../MailClientTab";
import { contactMocks, filterMocks, folder, getMessageRow, info, mailMocks, message, messageBody, renderMailbox, stepResult, uncachedMessage } from "./harness";

export function registerMailClientTabEditing1Cases() {

  it("keeps the loaded body when double-click opens the message in a tab", async () => {
    renderMailbox();

    await screen.findByText(/Second line stays visible/);
    fireEvent.doubleClick(getMessageRow());

    await waitFor(() => expect(screen.getByRole("button", { name: /Mailbox/ })).toBeInTheDocument());
    expect(screen.getByText(/Second line stays visible/)).toBeInTheDocument();
    expect(screen.queryByText(message.snippet ?? "")).not.toBeInTheDocument();
  });

  it("applies a successful auto-read result when the body finishes loading first", async () => {
    let finishRead!: (value: { folder: string; marked: number; }) => void;
    mailMocks.mailListCachedMessages.mockResolvedValue([{ ...message, flags: [] }]);
    mailMocks.mailMarkRead.mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));
    renderMailbox();
    await screen.findByText(/Second line stays visible/);
    await waitFor(() => expect(mailMocks.mailMarkRead).toHaveBeenCalledWith(info, "INBOX", [101], false));
    expect(screen.getByTestId("mail-message-row")).toHaveAttribute("data-unread", "true");
    await act(async () => finishRead({ folder: "INBOX", marked: 1 }));
    await waitFor(() => expect(screen.getByTestId("mail-message-row")).toHaveAttribute("data-unread", "false"));
    expect(mailMocks.mailMarkRead).toHaveBeenCalledTimes(1);
  });

  it("keeps the loaded body when opening the message popup", async () => {
    renderMailbox();

    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByRole("button", { name: "Popup" }));

    const dialog = await screen.findByRole("dialog", { name: message.subject });
    expect(within(dialog).getByText(/Second line stays visible/)).toBeInTheDocument();
    expect(within(dialog).queryByText(message.snippet ?? "")).not.toBeInTheDocument();
  });

  it("shows the load older button when folder totals exceed cached rows", async () => {
    mailMocks.mailListCachedFolders.mockResolvedValue([{ ...folder, total: 2 }]);
    mailMocks.mailListCachedMessages.mockResolvedValue([message]);

    renderMailbox();

    expect(await screen.findByRole("button", { name: /Load older messages/ })).toBeInTheDocument();
  });

  it("uses saved mail font settings as the initial mail UI appearance", async () => {
    render(
      <MailClientTab
        tabId="mail-tab"
        info={{
          ...info,
          terminalProfile: {
            ...DEFAULT_TERMINAL_PROFILE,
            fontFamily: "Cascadia Mono",
            fontSize: 22,
          },
        }}
        visible
      />,
    );

    const root = await screen.findByTestId("mail-client-tab");
    expect(root.style.fontFamily).toContain("Cascadia Mono");
    expect(root.style.getPropertyValue("zoom")).toBe(String(22 / DEFAULT_TERMINAL_PROFILE.fontSize));
  });

  it("applies code view theme colors to the mail chrome", async () => {
    render(
      <MailClientTab
        tabId="mail-tab"
        info={{
          ...info,
          terminalProfile: {
            ...DEFAULT_TERMINAL_PROFILE,
            theme: "code:dracula",
          },
        }}
        visible
      />,
    );

    const root = await screen.findByTestId("mail-client-tab");
    expect(root.style.getPropertyValue("--taomni-bg")).toBe("#282a36");
    expect(root.style.getPropertyValue("--taomni-text")).toBe("#f8f8f2");
    expect(root.style.getPropertyValue("--taomni-accent")).toBe("#8be9fd");
    expect(root.style.getPropertyValue("--taomni-accent-soft")).not.toBe("");
    expect(root.style.getPropertyValue("--taomni-button-from")).not.toBe("");
    expect(root.style.getPropertyValue("--taomni-button-hover-to")).not.toBe("");
    expect(root.style.getPropertyValue("--taomni-button-disabled")).not.toBe("");
    expect(root.style.getPropertyValue("--taomni-color-scheme")).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("uses a light color scheme for light mail themes", async () => {
    render(
      <MailClientTab
        tabId="mail-tab"
        info={{
          ...info,
          terminalProfile: {
            ...DEFAULT_TERMINAL_PROFILE,
            theme: "code:github-light",
          },
        }}
        visible
      />,
    );

    const root = await screen.findByTestId("mail-client-tab");
    expect(root.style.getPropertyValue("--taomni-color-scheme")).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("does not force borders onto HTML email layout tables", async () => {
    mailMocks.mailGetMessageBody.mockResolvedValue({
      ...messageBody,
      text: null,
      html: "<table><tbody><tr><td>Brand</td><td>Approval content</td></tr></tbody></table>",
    });

    renderMailbox();

    const frame = await screen.findByTestId("mail-reader-html");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("srcdoc") ?? "").toContain("Approval content");
    expect(frame.getAttribute("sandbox") ?? "").toContain("allow-same-origin");
    expect(frame.className).not.toContain("_td]:border");
    expect(frame.className).not.toContain("_td]:px");
    expect(frame.className).not.toContain("_td]:py");
  });

  it("syncs headers first and shows body warming as separate progress", async () => {
    let resolveWarmBody!: () => void;
    const warmBodyPromise = new Promise<void>((resolve) => {
      resolveWarmBody = resolve;
    });
    mailMocks.mailListCachedMessages.mockReset();
    mailMocks.mailListCachedMessages
      .mockResolvedValueOnce([message])
      .mockResolvedValueOnce([uncachedMessage])
      .mockResolvedValueOnce([uncachedMessage]);
    mailMocks.mailPrefetchMessageBody.mockReturnValue(warmBodyPromise);
    mailMocks.mailGetMessageBody.mockImplementation((_config: MailTabInfo, _folder: string, uid: number) =>
      Promise.resolve(uid === uncachedMessage.uid ? {
        ...messageBody, uid, messageId: uncachedMessage.messageId, subject: uncachedMessage.subject,
        text: "Interactive body while warming is pending",
      } : messageBody));

    renderMailbox();

    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByTestId("mail-sync-button"));

    await waitFor(() => expect(mailMocks.mailSyncAllFolders).toHaveBeenCalledWith(
      { ...info, sync: { ...info.sync, subscribedOnly: false } },
      { limit: 50, includeBodies: false, fullReconcile: true },
    ));
    expect(await screen.findByText(/Header arrived before the body cache is warm/)).toBeInTheDocument();
    expect(await screen.findByTestId("mail-body-warming-progress")).toHaveTextContent("Bodies 0/1");

    expect(mailMocks.mailPrefetchMessageBody).toHaveBeenCalledWith(info, "INBOX", uncachedMessage.uid);
    // Warming is still pending; opening that message must use the interactive
    // path instead of waiting on the background promise or changing the reader.
    fireEvent.click(screen.getByTestId("mail-message-row"));
    expect(await screen.findByText("Interactive body while warming is pending")).toBeInTheDocument();
    expect(screen.getByTestId("mail-body-warming-progress")).toHaveTextContent("Bodies 0/1");
    resolveWarmBody();

    await waitFor(() => expect(screen.queryByTestId("mail-body-warming-progress")).not.toBeInTheDocument());
  });

  it("prompts to reauthorize when OAuth refresh is no longer valid", async () => {
    const oauthInfo: MailTabInfo = {
      ...info,
      provider: "outlook",
      authMode: "oauth2",
      oauth: {
        clientId: "client-id",
        tokenRef: "vault:mail-oauth-token",
        expiresAt: 1,
        scope: "offline_access https://outlook.office.com/IMAP.AccessAsUser.All",
      },
    };
    mailMocks.mailSyncAllFolders.mockRejectedValueOnce(
      new Error("OAuth2 authorization expired or was revoked. Reauthorize this mail account in session settings. Detail: invalid_grant"),
    );
    const onEditSession = vi.fn();

    render(<MailClientTab tabId="mail-tab" info={oauthInfo} visible onEditSession={onEditSession} />);

    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByTestId("mail-sync-button"));

    expect(await screen.findByText("OAuth authorization expired or was revoked. Reauthorize this mail account.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reauthorize/i }));
    expect(onEditSession).toHaveBeenCalledWith(oauthInfo.sessionId);
  });

  it("defers auto-sync UI refresh and body warming while hidden", async () => {
    const syncOnOpenInfo: MailTabInfo = {
      ...info,
      sync: { ...info.sync, onOpen: true },
    };
    let resolveSync!: (value: MailFolderSyncResult) => void;
    mailMocks.mailSyncFolder.mockReturnValue(new Promise((resolve) => {
      resolveSync = resolve;
    }));

    const view = render(<MailClientTab tabId="mail-tab" info={syncOnOpenInfo} visible />);

    await screen.findByText(/Second line stays visible/);
    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalledWith(
      syncOnOpenInfo,
      "INBOX",
      { mode: "auto", limit: 50, includeBodies: false },
    ));
    mailMocks.mailListCachedFolders.mockClear();
    mailMocks.mailListCachedMessages.mockClear();
    mailMocks.mailGetMessageBody.mockClear();

    view.rerender(<MailClientTab tabId="mail-tab" info={syncOnOpenInfo} visible={false} />);
    await waitFor(() => expect(screen.getByTestId("mail-client-tab")).toHaveAttribute("aria-hidden", "true"));

    await act(async () => {
      resolveSync(stepResult({ messages: [message], fetched: 1 }));
      await Promise.resolve();
    });

    expect(mailMocks.mailListCachedFolders).not.toHaveBeenCalled();
    expect(mailMocks.mailListCachedMessages).not.toHaveBeenCalled();
    expect(mailMocks.mailGetMessageBody).not.toHaveBeenCalled();

    view.rerender(<MailClientTab tabId="mail-tab" info={syncOnOpenInfo} visible />);

    await waitFor(() => expect(mailMocks.mailListCachedFolders).toHaveBeenCalledWith(info.sessionId));
    await waitFor(() => expect(mailMocks.mailListCachedMessages).toHaveBeenCalledWith(
      info.sessionId,
      "INBOX",
      51,
      0,
    ));
  });

  it("catches up every message that arrived while the tab was closed (AC-01)", async () => {
    const syncOnOpenInfo: MailTabInfo = { ...info, sync: { ...info.sync, onOpen: true } };
    const arrivals = Array.from({ length: 120 }, (_, index): MailMessageHeader => ({
      ...uncachedMessage,
      uid: 1000 + index,
      messageId: `arrival-${index}@example.com`,
      subject: `Arrival ${index}`,
      flags: [],
    }));
    const pages = [arrivals.slice(70), arrivals.slice(20, 70), arrivals.slice(0, 20)];
    // Each backend step writes its page into the cache before returning.
    let cacheRows: MailMessageHeader[] = [message];
    mailMocks.mailSyncFolder.mockImplementation(async () => {
      const page = pages.shift() ?? [];
      cacheRows = [...page, ...cacheRows];
      const left = pages.reduce((sum, rest) => sum + rest.length, 0);
      return stepResult({ messages: page, fetched: page.length, newUnseen: page.length, remainingNew: left, more: left > 0 });
    });
    mailMocks.mailListCachedMessages.mockImplementation(async (_account, _folder, limit, offset) =>
      cacheRows.slice(offset, offset + limit));

    render(<MailClientTab tabId="mail-tab" info={syncOnOpenInfo} visible />);

    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(3));
    // Index every arrival without growing the DOM beyond the first page.
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "50"));
    expect(cacheRows).toHaveLength(121);
    fireEvent.click(screen.getByTestId("mail-load-more"));
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "100"));
    fireEvent.click(screen.getByTestId("mail-load-more"));
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "121"));
    expect(useTaoAlertStore.getState().mailNew).toMatchObject([{ count: 120, mailTabId: "mail-tab" }]);
  });

  it("runs the incoming filters after new INBOX mail arrives (AC-40/AC-42)", async () => {
    const syncOnOpenInfo: MailTabInfo = { ...info, sync: { ...info.sync, onOpen: true } };
    const arrival: MailMessageHeader = { ...uncachedMessage, uid: 2000, messageId: "new@example.com", flags: [] };
    mailMocks.mailSyncFolder.mockResolvedValueOnce(stepResult({ messages: [arrival], fetched: 1, newUnseen: 1 }));
    filterMocks.mailApplyFilters.mockResolvedValue({
      folder: "INBOX",
      examined: 1,
      matched: 1,
      moved: 1,
      errors: ["copy to Backup: folder missing"],
    });
    render(<MailClientTab tabId="mail-tab" info={syncOnOpenInfo} visible />);
    await waitFor(() => expect(filterMocks.mailApplyFilters).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: info.sessionId }),
      "INBOX",
      "incoming",
      expect.objectContaining({ trashFolder: null }),
    ));
    expect(await screen.findByTestId("mail-filters-error-badge")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mail-filters-open"));
    expect(await screen.findByTestId("mail-filters-recent-errors")).toHaveTextContent("copy to Backup: folder missing");
  });

  it("creates a filter from a message context menu (DEC-11)", async () => {
    renderMailbox();
    await screen.findByText(message.subject);
    fireEvent.contextMenu(getMessageRow());
    fireEvent.click(await screen.findByTestId("mail-menu-create-filter"));
    expect(await screen.findByTestId("mail-filter-editor")).toBeInTheDocument();
    expect(screen.getByTestId("mail-filter-condition-value")).toHaveValue(message.from?.address);
    expect(screen.getByTestId("mail-filter-name")).toHaveValue(`From ${message.from?.name || message.from?.address}`);
    expect(filterMocks.mailApplyFilters).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "manual", expect.anything());
  });

  it("adds a message sender to the address book (TASK-19)", async () => {
    contactMocks.mailSaveAddressBookEntry.mockImplementation(async (_config: unknown, entry: { displayName: string; }) => ({
      ...entry,
      uid: "c1",
      book: "local",
    }));
    renderMailbox();
    await screen.findByText(message.subject);
    fireEvent.contextMenu(getMessageRow());
    fireEvent.click(await screen.findByTestId("mail-menu-add-contact"));
    expect(await screen.findByTestId("mail-contact-editor")).toBeInTheDocument();
    expect(screen.getByTestId("mail-contact-email")).toHaveValue(message.from?.address);
    fireEvent.click(screen.getByTestId("mail-contact-save"));
    await waitFor(() => expect(contactMocks.mailSaveAddressBookEntry).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: info.sessionId }),
      expect.objectContaining({ emails: [message.from?.address] }),
    ));
    expect(await screen.findByTestId("mail-address-book")).toBeInTheDocument();
  });

  it("keeps periodic sync running while hidden and refreshes from cache when visible", async () => {
    vi.useFakeTimers();
    const intervalInfo: MailTabInfo = {
      ...info,
      sync: { ...info.sync, onOpen: false, intervalMinutes: 1 },
    };
    const freshFolder: MailFolder = {
      ...folder,
      total: 2,
      unread: 1,
      updatedAt: 2,
    };
    const freshMessage: MailMessageHeader = {
      ...uncachedMessage,
      flags: [],
    };
    mailMocks.mailSyncFolder.mockResolvedValue(stepResult({
      folder: freshFolder,
      messages: [freshMessage],
      fetched: 1,
      newUnseen: 1,
    }));
    mailMocks.mailListCachedFolders.mockResolvedValue([freshFolder]);
    mailMocks.mailListCachedMessages.mockResolvedValue([freshMessage]);

    const view = render(<MailClientTab tabId="mail-tab" info={intervalInfo} visible={false} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // Quiet ticks catch up the selected folder (INBOX) and reconcile its newest window.
    expect(mailMocks.mailSyncFolder).toHaveBeenCalledWith(
      intervalInfo,
      "INBOX",
      { mode: "auto", limit: 50, includeBodies: false },
    );
    expect(mailMocks.mailSyncFolder).toHaveBeenCalledWith(
      intervalInfo,
      "INBOX",
      { mode: "reconcile", limit: 50, includeBodies: false },
    );
    expect(mailMocks.mailSyncAllFolders).not.toHaveBeenCalled();
    expect(mailMocks.mailListCachedFolders).not.toHaveBeenCalled();
    expect(mailMocks.mailListCachedMessages).not.toHaveBeenCalled();

    view.rerender(<MailClientTab tabId="mail-tab" info={intervalInfo} visible />);

    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(mailMocks.mailListCachedFolders).toHaveBeenCalledWith(info.sessionId);
    expect(mailMocks.mailListCachedMessages).toHaveBeenCalledWith(
      info.sessionId,
      "INBOX",
      51,
      0,
    );
    expect(screen.getAllByText(/Header arrived before the body cache is warm/).length).toBeGreaterThan(0);
  });
}
