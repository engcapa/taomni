import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { MailFolder, MailFolderSyncResult, MailMessageBody, MailMessageHeader } from "../../../../lib/mail";
import type { MailTabInfo } from "../../../../types";
import { MailClientTab } from "../../MailClientTab";

const mailMocks = vi.hoisted(() => ({
  mailClearCache: vi.fn(),
  mailCopyMessages: vi.fn(),
  mailCreateFolder: vi.fn(),
  mailDeleteFolder: vi.fn(),
  mailDeleteMessages: vi.fn(),
  mailDownloadAttachment: vi.fn(),
  mailFetchRaw: vi.fn(),
  mailGetMessageBody: vi.fn(),
  mailPrefetchMessageBody: vi.fn(),
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
  mailListFolders: vi.fn(),
  mailUnsubscribeOneClick: vi.fn(),
  mailExportMbox: vi.fn(),
  mailImportMessages: vi.fn(),
  mailProbeCertificate: vi.fn(),
  mailGetInvite: vi.fn(),
  mailSendReceipt: vi.fn(),
  mailRespondInvite: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown; }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown; }) => void) => {
    eventMocks.handlers.set(name, handler);
    return () => eventMocks.handlers.delete(name);
  }),
}));

const chatState = vi.hoisted(() => ({
  activeThreadId: "thread-1",
  openTabChat: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../../../lib/mail", () => ({
  ...mailMocks,
  mailArchiveStart: vi.fn(async () => undefined),
  mailArchiveStatus: vi.fn(async () => ({ phase: "completed", saved: 0, total: 0, bytes: 0 })),
  MAIL_IDLE_EVENT: "mail://idle",
  MAIL_MDN_SENT: "$MDNSent",
  isMailCertificateError: (message: string | null | undefined) =>
    /untrusted server certificate|no longer matches the one you trusted/i.test(message ?? ""),
}));

const filterMocks = vi.hoisted(() => ({
  mailApplyFilters: vi.fn(),
  mailListFilters: vi.fn(),
  mailSaveFilters: vi.fn(),
}));

vi.mock("../../../../lib/mailFilters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/mailFilters")>()),
  ...filterMocks,
}));

const contactMocks = vi.hoisted(() => ({
  mailListAddressBook: vi.fn(async () => []),
  mailSaveAddressBookEntry: vi.fn(),
}));

vi.mock("../../../../lib/mailContacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/mailContacts")>()),
  ...contactMocks,
}));

const calendarMocks = vi.hoisted(() => ({
  mailAddInviteToCalendar: vi.fn(),
  mailCalDavSync: vi.fn(async () => ({ collection: "c", events: 0, errors: [] })),
  mailListAgenda: vi.fn(async () => []),
}));

vi.mock("../../../../lib/mailCalendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/mailCalendar")>()),
  ...calendarMocks,
}));

vi.mock("../../../../lib/ipc", () => ({
  openLocalPath: vi.fn(),
  selectUploadFile: vi.fn(async () => []),
  temporaryFilePath: vi.fn(async (name: string) => `/tmp/${name}`),
  readFileBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
  writeStreamOpen: vi.fn(async () => "handle-1"),
  writeStreamAppend: vi.fn(async () => undefined),
  writeStreamClose: vi.fn(async () => undefined),
  writeStreamAbort: vi.fn(async () => undefined),
}));

vi.mock("../../../../stores/chatStore", () => {
  const useChatStore = ((selector: (state: typeof chatState) => unknown) => selector(chatState)) as
    ((selector: (state: typeof chatState) => unknown) => unknown) & { getState: () => typeof chatState; };
  useChatStore.getState = () => chatState;
  return { useChatStore };
});

export const info: MailTabInfo = {
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

export const folder: MailFolder = {
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

export const message: MailMessageHeader = {
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

export const messageBody: MailMessageBody = {
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

export const uncachedMessage: MailMessageHeader = {
  ...message,
  uid: 102,
  messageId: "message-102@example.com",
  subject: "Fresh header",
  snippet: "Header arrived before the body cache is warm.",
  bodyCached: false,
};

export function renderMailbox() {
  return render(<MailClientTab tabId="mail-tab" info={info} visible />);
}

export function getMessageRow(): HTMLElement {
  const row = screen.getAllByRole("button").find((button) =>
    button.textContent?.includes(message.snippet ?? ""),
  );
  if (!row) throw new Error("message row not found");
  return row;
}

export function stepResult(overrides: Partial<MailFolderSyncResult>): MailFolderSyncResult {
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

export { calendarMocks, chatState, contactMocks, eventMocks, filterMocks, mailMocks };
