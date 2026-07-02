import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailTabInfo } from "../../types";
import type { MailFolder, MailMessageBody, MailMessageHeader } from "../../lib/mail";
import { DEFAULT_TERMINAL_PROFILE } from "../../lib/terminalProfile";
import { MailClientTab } from "./MailClientTab";

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
  });

  afterEach(() => {
    cleanup();
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

  it("does not use terminal font settings as the initial mail UI zoom", async () => {
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
    expect(root.style.fontFamily).toBe("var(--taomni-ui-font-family)");
    expect(root.style.getPropertyValue("zoom")).toBe("1");
  });

  it("does not force borders onto HTML email layout tables", async () => {
    mailMocks.mailGetMessageBody.mockResolvedValue({
      ...messageBody,
      text: null,
      html: "<table><tbody><tr><td>Brand</td><td>Approval content</td></tr></tbody></table>",
    });

    renderMailbox();

    const html = await screen.findByTestId("mail-reader-html");
    expect(html).toHaveTextContent("Approval content");
    expect(html.className).not.toContain("_td]:border");
    expect(html.className).not.toContain("_td]:px");
    expect(html.className).not.toContain("_td]:py");
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
});
