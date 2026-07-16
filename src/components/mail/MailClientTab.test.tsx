import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailTabInfo } from "../../types";
import type { MailFolder, MailMessageBody, MailMessageHeader } from "../../lib/mail";
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
  mailSyncAllFolders: vi.fn(),
  mailSyncHeaders: vi.fn(),
  mailTestConnection: vi.fn(),
}));

const chatState = vi.hoisted(() => ({
  activeThreadId: "thread-1",
  openTabChat: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../lib/mail", () => mailMocks);

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
      info,
      { limit: 50, includeBodies: false },
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
    let resolveSync!: (value: Awaited<ReturnType<typeof mailMocks.mailSyncHeaders>>) => void;
    mailMocks.mailSyncHeaders.mockReturnValue(new Promise((resolve) => {
      resolveSync = resolve;
    }));

    const view = render(<MailClientTab tabId="mail-tab" info={syncOnOpenInfo} visible />);

    await screen.findByText(/Second line stays visible/);
    await waitFor(() => expect(mailMocks.mailSyncHeaders).toHaveBeenCalledWith(
      syncOnOpenInfo,
      "INBOX",
      { limit: 50, offset: 0, includeBodies: false, refreshFolders: true },
    ));
    mailMocks.mailListCachedFolders.mockClear();
    mailMocks.mailListCachedMessages.mockClear();
    mailMocks.mailGetMessageBody.mockClear();

    view.rerender(<MailClientTab tabId="mail-tab" info={syncOnOpenInfo} visible={false} />);
    await waitFor(() => expect(screen.getByTestId("mail-client-tab")).toHaveAttribute("aria-hidden", "true"));

    await act(async () => {
      resolveSync({
        accountId: info.sessionId,
        folder: "INBOX",
        folders: [folder],
        messages: [message],
        fetchedMessages: 1,
        cachedBodies: 0,
        syncedAt: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
      });
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
    mailMocks.mailSyncAllFolders.mockResolvedValue({
      accountId: info.sessionId,
      folders: [freshFolder],
      fetchedMessages: 1,
      cachedBodies: 0,
      syncedAt: 2,
    });
    mailMocks.mailListCachedFolders.mockResolvedValue([freshFolder]);
    mailMocks.mailListCachedMessages.mockResolvedValue([freshMessage]);

    const view = render(<MailClientTab tabId="mail-tab" info={intervalInfo} visible={false} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    // Quiet ticks refresh selected folder (INBOX) without remote LIST.
    expect(mailMocks.mailSyncHeaders).toHaveBeenCalledWith(
      intervalInfo,
      "INBOX",
      { limit: 50, includeBodies: false, refreshFolders: false },
    );
    expect(mailMocks.mailSyncHeaders).toHaveBeenCalledTimes(1);
    expect(mailMocks.mailSyncAllFolders).not.toHaveBeenCalled();
    expect(mailMocks.mailListCachedFolders).not.toHaveBeenCalled();
    expect(mailMocks.mailListCachedMessages).not.toHaveBeenCalled();

    view.rerender(<MailClientTab tabId="mail-tab" info={intervalInfo} visible />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
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

    let resolveSent!: (value: {
      accountId: string;
      folder: string;
      folders: MailFolder[];
      messages: MailMessageHeader[];
      fetchedMessages: number;
      cachedBodies: number;
      syncedAt: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    }) => void;
    mailMocks.mailSyncHeaders.mockImplementation((_config: MailTabInfo, folderName?: string | null) => {
      if (folderName === "Sent") {
        return new Promise((resolve) => {
          resolveSent = resolve;
        });
      }
      return Promise.resolve({
        accountId: info.sessionId,
        folder: "INBOX",
        folders: [folder, sentFolder],
        messages: [inboxOnlyMessage],
        fetchedMessages: 1,
        cachedBodies: 0,
        syncedAt: 2,
        offset: 0,
        limit: 50,
        hasMore: false,
      });
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(mailMocks.mailSyncHeaders).toHaveBeenCalledWith(
      intervalInfo,
      "Sent",
      { limit: 50, includeBodies: false, refreshFolders: false },
    );

    // Switch to INBOX while the Sent poll is still awaiting.
    fireEvent.click(screen.getByText("Inbox"));
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(screen.getAllByText(/Stays visible after mid-poll switch/).length).toBeGreaterThan(0);

    // Complete the stale Sent poll; messages must stay on INBOX.
    await act(async () => {
      resolveSent({
        accountId: info.sessionId,
        folder: "Sent",
        folders: [folder, sentFolder],
        messages: [{ ...sentMessage, subject: "Stale Sent overwrite", snippet: "Must not appear" }],
        fetchedMessages: 1,
        cachedBodies: 0,
        syncedAt: 3,
        offset: 0,
        limit: 50,
        hasMore: false,
      });
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
    mailMocks.mailSyncHeaders.mockImplementation(async (_config: MailTabInfo, folderName?: string | null) => ({
      accountId: info.sessionId,
      folder: folderName ?? "INBOX",
      folders: [folder, sentFolder],
      messages: folderName === "Sent"
        ? [{ ...message, folder: "Sent", uid: 201, subject: "Sent item" }]
        : [message],
      fetchedMessages: 1,
      cachedBodies: 0,
      syncedAt: 2,
      offset: 0,
      limit: 50,
      hasMore: false,
    }));

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
    mailMocks.mailSyncHeaders.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(mailMocks.mailSyncHeaders).toHaveBeenCalledWith(
      intervalInfo,
      "Sent",
      { limit: 50, includeBodies: false, refreshFolders: false },
    );
    expect(mailMocks.mailSyncHeaders).toHaveBeenCalledWith(
      intervalInfo,
      "INBOX",
      { limit: 50, includeBodies: false, refreshFolders: false },
    );
    expect(mailMocks.mailSyncHeaders).toHaveBeenCalledTimes(2);
    expect(mailMocks.mailSyncAllFolders).not.toHaveBeenCalled();
  });

  it("pushes a Tao mail notification when periodic full-folder sync reports new messages", async () => {
    vi.useFakeTimers();
    const intervalInfo: MailTabInfo = {
      ...info,
      sync: { ...info.sync, onOpen: false, intervalMinutes: 1 },
    };
    mailMocks.mailSyncHeaders.mockResolvedValue({
      accountId: info.sessionId,
      folder: "INBOX",
      folders: [folder],
      messages: [],
      fetchedMessages: 0,
      cachedBodies: 0,
      syncedAt: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
    });
    mailMocks.mailSyncAllFolders.mockResolvedValue({
      accountId: info.sessionId,
      folders: [folder],
      fetchedMessages: 2,
      newMessages: 2,
      cachedBodies: 0,
      syncedAt: 2,
    });

    render(<MailClientTab tabId="mail-tab" info={intervalInfo} visible={false} />);

    // Full-folder scan runs every 6th quiet tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60_000);
    });

    expect(mailMocks.mailSyncAllFolders).toHaveBeenCalled();
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

  it("skips overlapping periodic sync ticks while a sync is still running", async () => {
    vi.useFakeTimers();
    const intervalInfo: MailTabInfo = {
      ...info,
      sync: { ...info.sync, onOpen: false, intervalMinutes: 1 },
    };
    const syncResult = {
      accountId: info.sessionId,
      folder: "INBOX",
      folders: [folder],
      messages: [],
      fetchedMessages: 1,
      cachedBodies: 0,
      syncedAt: 2,
      offset: 0,
      limit: 50,
      hasMore: false,
    };
    let resolveSync!: (value: typeof syncResult) => void;
    mailMocks.mailSyncHeaders.mockReturnValue(new Promise((resolve) => {
      resolveSync = resolve;
    }));

    render(<MailClientTab tabId="mail-tab" info={intervalInfo} visible={false} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mailMocks.mailSyncHeaders).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mailMocks.mailSyncHeaders).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSync(syncResult);
      await Promise.resolve();
    });
    mailMocks.mailSyncHeaders.mockResolvedValue(syncResult);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mailMocks.mailSyncHeaders).toHaveBeenCalledTimes(2);
  });
});
