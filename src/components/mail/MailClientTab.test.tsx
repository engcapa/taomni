import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailTabInfo } from "../../types";
import type { MailFolder, MailFolderSyncResult, MailMessageBody, MailMessageHeader } from "../../lib/mail";
import { DEFAULT_TERMINAL_PROFILE } from "../../lib/terminalProfile";
import { MailClientTab } from "./MailClientTab";
import { useTaoAlertStore } from "../../stores/taoAlertStore";

const mailMocks = vi.hoisted(() => ({
  mailClearCache: vi.fn(),
  mailCopyMessages: vi.fn(),
  mailCreateFolder: vi.fn(),
  mailDeleteFolder: vi.fn(),
  mailDeleteMessages: vi.fn(),
  mailDownloadAttachment: vi.fn(),
  mailFetchRaw: vi.fn(),
  mailGetMessageBody: vi.fn(),
  mailIndexCachedContacts: vi.fn(),
  mailDeleteDraft: vi.fn(),
  mailDiscardRemoteDraft: vi.fn(),
  mailStoreRemoteDraft: vi.fn(),
  mailListDrafts: vi.fn(),
  mailListCachedFolders: vi.fn(),
  mailListCachedMessages: vi.fn(),
  mailSaveDraft: vi.fn(),
  mailMarkRead: vi.fn(),
  mailMoveMessages: vi.fn(),
  mailRenameFolder: vi.fn(),
  mailSaveRaw: vi.fn(),
  mailSendMessage: vi.fn(),
  mailSetFlags: vi.fn(),
  mailSearchContacts: vi.fn(),
  mailSearchMessages: vi.fn(),
  mailSearchServer: vi.fn(),
  mailSyncAllFolders: vi.fn(),
  mailSyncFolder: vi.fn(),
  mailSyncHeaders: vi.fn(),
  mailTestConnection: vi.fn(),
  mailIdleStart: vi.fn(),
  mailIdleStop: vi.fn(),
  mailSetFolderSubscription: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    eventMocks.handlers.set(name, handler);
    return () => eventMocks.handlers.delete(name);
  }),
}));

const chatState = vi.hoisted(() => ({
  activeThreadId: "thread-1",
  openTabChat: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../lib/mail", () => ({ ...mailMocks, MAIL_IDLE_EVENT: "mail://idle" }));

vi.mock("../../lib/ipc", () => ({
  openLocalPath: vi.fn(),
  selectUploadFile: vi.fn(async () => []),
  temporaryFilePath: vi.fn(async (name: string) => `/tmp/${name}`),
  readFileBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
  writeStreamOpen: vi.fn(async () => "handle-1"),
  writeStreamAppend: vi.fn(async () => undefined),
  writeStreamClose: vi.fn(async () => undefined),
  writeStreamAbort: vi.fn(async () => undefined),
}));

vi.mock("../../stores/chatStore", () => {
  const useChatStore = ((selector: (state: typeof chatState) => unknown) => selector(chatState)) as
    ((selector: (state: typeof chatState) => unknown) => unknown) & { getState: () => typeof chatState };
  useChatStore.getState = () => chatState;
  return { useChatStore };
});

const info: MailTabInfo = {
  sessionId: "mail-account-1",
  emailAddress: "me@example.com",
  provider: "custom",
  authMode: "password",
  displayName: "Me",
  replyTo: null,
  signature: null,
  imap: {
    host: "imap.example.com",
    port: 993,
    username: "me@example.com",
    password: "secret",
    security: "tls",
  },
  smtp: {
    host: "smtp.example.com",
    port: 465,
    username: "me@example.com",
    password: "secret",
    security: "tls",
    useImapAuth: true,
  },
  oauth: {
    clientId: null,
    tokenRef: null,
    expiresAt: null,
    scope: null,
  },
  sync: {
    onOpen: false,
    intervalMinutes: 0,
    maxFetchPerSync: 50,
  },
  cache: {
    enabled: true,
    headerRetentionDays: 30,
    headerLimitPerFolder: 500,
    bodyRecentLimit: 50,
    bodyMaxBytes: 512000,
    attachmentCache: false,
    saveDirectory: null,
  },
  ai: {
    enabled: false,
    skipBodyConfirm: false,
  },
};

const folder: MailFolder = {
  accountId: info.sessionId,
  name: "INBOX",
  displayName: "Inbox",
  delimiter: "/",
  flags: [],
  uidValidity: 1,
  uidNext: 2,
  total: 1,
  unread: 0,
  updatedAt: 1,
};

const message: MailMessageHeader = {
  accountId: info.sessionId,
  folder: "INBOX",
  uid: 101,
  messageId: "message-101@example.com",
  subject: "Quota notice",
  from: { name: "Admin", address: "admin@example.com" },
  to: [{ name: "Me", address: "me@example.com" }],
  cc: [],
  dateTs: 1710000000,
  flags: ["\\Seen"],
  hasAttachments: false,
  attachmentCount: 0,
  attachments: [],
  snippet: "Short cached preview should not replace the loaded body.",
  rawSize: 7000,
  bodyCached: true,
};

const messageBody: MailMessageBody = {
  accountId: info.sessionId,
  folder: "INBOX",
  uid: 101,
  messageId: "message-101@example.com",
  subject: "Quota notice",
  text: "Full message body first line.\nSecond line stays visible after opening.",
  html: null,
  snippet: message.snippet,
  attachments: [],
  rawSize: 7000,
  cachedAt: 1710000010,
  source: "cache",
};

const uncachedMessage: MailMessageHeader = {
  ...message,
  uid: 102,
  messageId: "message-102@example.com",
  subject: "Fresh header",
  snippet: "Header arrived before the body cache is warm.",
  bodyCached: false,
};

function renderMailbox() {
  return render(<MailClientTab tabId="mail-tab" info={info} visible />);
}

function getMessageRow(): HTMLElement {
  const row = screen.getAllByRole("button").find((button) =>
    button.textContent?.includes(message.snippet ?? ""),
  );
  if (!row) throw new Error("message row not found");
  return row;
}

describe("MailClientTab", () => {
  beforeEach(() => {
    for (const mock of Object.values(mailMocks)) mock.mockReset();
    for (const mock of Object.values(chatState)) {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    }

    mailMocks.mailListCachedFolders.mockResolvedValue([folder]);
    mailMocks.mailListCachedMessages.mockResolvedValue([message]);
    mailMocks.mailGetMessageBody.mockResolvedValue(messageBody);
    mailMocks.mailIndexCachedContacts.mockResolvedValue(undefined);
    mailMocks.mailListDrafts.mockResolvedValue([]);
    mailMocks.mailMarkRead.mockResolvedValue({ folder: "INBOX", marked: 0 });
    mailMocks.mailSearchContacts.mockResolvedValue([]);
    mailMocks.mailSyncAllFolders.mockResolvedValue({
      accountId: info.sessionId,
      folders: [folder],
      fetchedMessages: 0,
      newMessages: 0,
      cachedBodies: 0,
      syncedAt: 0,
    });
    mailMocks.mailSyncHeaders.mockResolvedValue({
      accountId: info.sessionId,
      folder: "INBOX",
      folders: [folder],
      messages: [message],
      fetchedMessages: 1,
      cachedBodies: 1,
      syncedAt: 0,
      offset: 0,
      limit: 1,
      hasMore: false,
    });
    mailMocks.mailSyncFolder.mockResolvedValue(stepResult({}));
    mailMocks.mailIdleStart.mockResolvedValue(true);
    mailMocks.mailIdleStop.mockResolvedValue(true);
    eventMocks.handlers.clear();
    useTaoAlertStore.setState({ aiDone: [], mailNew: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useTaoAlertStore.setState({ aiDone: [], mailNew: [] });
  });

  it("keeps the loaded body when double-click opens the message in a tab", async () => {
    renderMailbox();

    await screen.findByText(/Second line stays visible/);
    fireEvent.doubleClick(getMessageRow());

    await waitFor(() => expect(screen.getByRole("button", { name: /Mailbox/ })).toBeInTheDocument());
    expect(screen.getByText(/Second line stays visible/)).toBeInTheDocument();
    expect(screen.queryByText(message.snippet ?? "")).not.toBeInTheDocument();
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
    let resolveWarmBody!: (body: MailMessageBody) => void;
    const warmBodyPromise = new Promise<MailMessageBody>((resolve) => {
      resolveWarmBody = resolve;
    });
    mailMocks.mailListCachedMessages.mockReset();
    mailMocks.mailListCachedMessages
      .mockResolvedValueOnce([message])
      .mockResolvedValueOnce([uncachedMessage])
      .mockResolvedValueOnce([uncachedMessage]);
    mailMocks.mailGetMessageBody.mockImplementation((_config: MailTabInfo, _folder: string, uid: number) => {
      if (uid === uncachedMessage.uid) return warmBodyPromise;
      return Promise.resolve(messageBody);
    });

    renderMailbox();

    await screen.findByText(/Second line stays visible/);
    fireEvent.click(screen.getByTestId("mail-sync-button"));

    await waitFor(() => expect(mailMocks.mailSyncAllFolders).toHaveBeenCalledWith(
      { ...info, sync: { ...info.sync, subscribedOnly: false } },
      { limit: 50, includeBodies: false, fullReconcile: true },
    ));
    expect(await screen.findByText(/Header arrived before the body cache is warm/)).toBeInTheDocument();
    expect(await screen.findByTestId("mail-body-warming-progress")).toHaveTextContent("Bodies 0/1");

    resolveWarmBody({
      ...messageBody,
      uid: uncachedMessage.uid,
      messageId: uncachedMessage.messageId,
      subject: uncachedMessage.subject,
      snippet: uncachedMessage.snippet,
      source: "remote",
    });

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
    mailMocks.mailListCachedMessages.mockImplementation(async () => cacheRows);

    render(<MailClientTab tabId="mail-tab" info={syncOnOpenInfo} visible />);

    await waitFor(() => expect(mailMocks.mailSyncFolder).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByTestId("mail-message-count")).toHaveAttribute("data-count", "121"));
    expect(useTaoAlertStore.getState().mailNew).toMatchObject([{ count: 120, mailTabId: "mail-tab" }]);
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
    mailMocks.mailSyncFolder.mockImplementation(async (_config: MailTabInfo, _name: string, options: { mode: string }) => {
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

  it("searches the whole local index and the server (AC-25/AC-26)", async () => {
    const hit: MailMessageHeader = { ...uncachedMessage, uid: 7, folder: "Archive", subject: "Budget from archive" };
    const serverHit: MailMessageHeader = { ...uncachedMessage, uid: 8, subject: "Budget only on server" };
    mailMocks.mailSearchMessages.mockResolvedValue([hit]);
    mailMocks.mailSearchServer.mockResolvedValue([serverHit]);

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

  it("waits for background sync instead of dropping a manual sync click", async () => {
    let resolveSync: (value: MailFolderSyncResult) => void = () => {};
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
});

function stepResult(overrides: Partial<MailFolderSyncResult>): MailFolderSyncResult {
  return {
    accountId: info.sessionId,
    folder,
    mode: "catchup",
    messages: [],
    fetched: 0,
    newUnseen: 0,
    vanished: 0,
    flagsUpdated: 0,
    remainingNew: 0,
    more: false,
    syncComplete: false,
    uidValidityReset: false,
    syncedAt: 1,
    ...overrides,
  };
}
