import { mailArchiveStub } from "../mailArchiveStub";
import { stubMailAppend, stubMailClearCache, stubMailExpunge, stubMailFindHeader, stubMailListCached, stubMailListFolders, stubMailSearch, stubMailSyncAll, stubMailSyncFolder, stubMailIdleStart, stubMailSetSubscription, stubMailIdleStop, stubMailRecordSent, stubMailMutation, stubMailUpdateCachedFlags, stubMailMarkRead, type Seed as MailStubSeed, type StubMailSearchQuery } from "../mailServerStub";
import { stubApplyFilters, stubListFilters, stubSaveFilters } from "../mailFiltersStub";
import { stubAddressBookSuggestions, stubDeleteAddressBookEntry, stubListAddressBook, stubSaveAddressBookEntry } from "../mailContactsStub";
import type { MailAddressBookEntry } from "../../lib/mailContacts";
import { stubAddInviteToCalendar, stubCalDavSync, stubListAgenda } from "../mailCalendarStub";
import type { MailFilter } from "../../lib/mailFilters";
import { type InvokeArgs } from "./runtime";

export const MAIL_DRAFTS_STORAGE_KEY = "taomni.stub.mailDrafts.v1";

export const MAIL_STUB_FOLDERS = [
  { name: "INBOX", displayName: "INBOX", total: 3, unread: 1 },
  { name: "Sent", displayName: "Sent", total: 1, unread: 0 },
  { name: "Archive", displayName: "Archive", total: 8, unread: 0 },
  { name: "Trash", displayName: "Trash", total: 0, unread: 0 },
];

export function stubMailAccountId(args?: InvokeArgs): string {
  const config = args?.config as { sessionId?: string } | undefined;
  return ((args?.accountId as string | undefined) ?? config?.sessionId ?? "stub-mail").trim() || "stub-mail";
}

export function stubMailMessages(accountId: string, folder: string) {
  if (folder === "Trash") return [];
  const now = Math.floor(Date.now() / 1000);
  const inbox = [
    {
      accountId,
      folder: "INBOX",
      uid: 91,
      messageId: "<stub-91@taomni.local>",
      subject: "Welcome to Taomni Mail",
      from: { name: "Taomni Mail", address: "mail-preview@taomni.local" },
      to: [{ name: "Preview User", address: "user@example.com" }],
      cc: [],
      dateTs: now - 1800,
      flags: [],
      hasAttachments: false,
      attachmentCount: 0,
      attachments: [],
      snippet: "This preview uses IMAP/SMTP-shaped data and the same cache-first reader flow as the desktop backend.",
      rawSize: 8432,
      bodyCached: true,
    },
    {
      accountId,
      folder: "INBOX",
      uid: 90,
      messageId: "<stub-90@taomni.local>",
      subject: "Account-level AI policy",
      from: { name: "AI Assistant", address: "assistant@taomni.local" },
      to: [{ name: "Preview User", address: "user@example.com" }],
      cc: [],
      dateTs: now - 7200,
      flags: ["\\Seen"],
      hasAttachments: true,
      attachmentCount: 1,
      attachments: [{ name: "policy.txt", contentType: "text/plain", size: 1240 }],
      snippet: "Mail AI actions can reuse the existing Taomni chat drawer and skip body confirmation per account config.",
      rawSize: 12980,
      bodyCached: true,
    },
    {
      accountId,
      folder: "INBOX",
      uid: 89,
      messageId: "<stub-89@taomni.local>",
      subject: "HTML newsletter sample",
      from: { name: "Ops Digest", address: "ops@example.com" },
      to: [{ name: "Preview User", address: "user@example.com" }],
      cc: [],
      dateTs: now - 86400,
      flags: ["\\Seen"],
      hasAttachments: false,
      attachmentCount: 0,
      attachments: [],
      snippet: "Remote images are blocked in the reader until explicitly loaded.",
      rawSize: 33120,
      bodyCached: true,
    },
  ];
  if (folder === "Sent") {
    return [{
      ...inbox[0],
      folder,
      uid: 12,
      subject: "Sent preview message",
      from: { name: "Preview User", address: "user@example.com" },
      to: [{ name: "Teammate", address: "team@example.com" }],
      flags: ["\\Seen"],
      snippet: "This is a browser-preview sent message.",
    }];
  }
  if (folder === "Archive") return inbox.slice(1).map((message, index) => ({ ...message, folder, uid: 70 - index }));
  return inbox;
}

export const mailStubSeed: MailStubSeed = (accountId) => ({
  meta: MAIL_STUB_FOLDERS.map((folder) => ({ name: folder.name, displayName: folder.displayName })),
  messages: (folder) => stubMailMessages(accountId, folder),
});

export function stubMailBody(accountId: string, folder: string, uid: number) {
  const header = stubMailFindHeader(accountId, mailStubSeed, folder, uid)
    ?? stubMailMessages(accountId, folder).find((message) => message.uid === uid)
    ?? stubMailMessages(accountId, folder)[0];
  const html = uid === 89
    ? `<h2>Ops Digest</h2><p>The reader sanitizes HTML and blocks tracking images.</p><p><img src="https://example.com/tracker.png" alt="tracker"></p><table><tr><td>Queue</td><td>Healthy</td></tr></table>`
    : null;
  const text = html
    ? null
    : `Hello from Taomni Mail preview.\n\nThis body is shaped like a cached IMAP message body. Use Sync in the desktop build to fetch live mailbox data.\n\nSubject: ${header.subject}`;
  return {
    accountId,
    folder,
    uid: header.uid,
    messageId: header.messageId,
    subject: header.subject,
    text,
    html,
    snippet: header.snippet,
    attachments: header.attachments,
    rawSize: header.rawSize,
    cachedAt: Math.floor(Date.now() / 1000),
    source: "cache",
  };
}

export function stubMailContacts(accountId: string, query: string, limit: number) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const byEmail = new Map<string, { name: string | null; email: string; source: "history" | "sent"; score: number; lastSeenAt: number | null }>();
  for (const folder of MAIL_STUB_FOLDERS) {
    for (const message of stubMailMessages(accountId, folder.name)) {
      const sent = folder.name === "Sent";
      const addresses = [message.from, ...message.to, ...message.cc];
      for (const address of addresses) {
        const email = address.address;
        const haystack = `${address.name ?? ""} ${email}`.toLowerCase();
        if (!email || !haystack.includes(needle)) continue;
        const score = (email.toLowerCase().startsWith(needle) ? 300 : 0)
          + ((address.name ?? "").toLowerCase().startsWith(needle) ? 180 : 0)
          + (sent ? 80 : 20);
        const existing = byEmail.get(email.toLowerCase());
        if (!existing || score > existing.score) {
          byEmail.set(email.toLowerCase(), {
            name: address.name ?? null,
            email,
            source: sent ? "sent" : "history",
            score,
            lastSeenAt: message.dateTs ?? null,
          });
        }
      }
    }
  }
  return Array.from(byEmail.values())
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email))
    .slice(0, limit);
}

export interface StubMailDraft {
  id: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  attachments: Array<{
    path: string;
    name?: string | null;
    contentType?: string | null;
    inline?: boolean;
    contentId?: string | null;
    size?: number | null;
    modifiedAt?: number | null;
  }>;
  replyContext?: Record<string, unknown> | null;
  remoteDraftFolder?: string | null;
  remoteDraftUid?: number | null;
  createdAt: number;
  updatedAt: number;
}

export function loadMailDrafts(): StubMailDraft[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(MAIL_DRAFTS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMailDrafts(drafts: StubMailDraft[]): void {
  localStorage.setItem(MAIL_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
}

export function stubSaveMailDraft(accountId: string, draft: Record<string, unknown>): StubMailDraft {
  const drafts = loadMailDrafts();
  const id = typeof draft.id === "string" && draft.id.trim()
    ? draft.id.trim()
    : `stub-draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const existing = drafts.find((item) => item.accountId === accountId && item.id === id);
  const now = Math.floor(Date.now() / 1000);
  const attachments = Array.isArray(draft.attachments)
    ? draft.attachments
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .filter((item) => typeof item.path === "string" && item.path.trim().length > 0)
        .map((item) => ({
          path: String(item.path),
          name: typeof item.name === "string" ? item.name : null,
          contentType: typeof item.contentType === "string" ? item.contentType : null,
          inline: item.inline === true,
          contentId: typeof item.contentId === "string" ? item.contentId : null,
          size: typeof item.size === "number" ? item.size : null,
          modifiedAt: typeof item.modifiedAt === "number" ? item.modifiedAt : null,
        }))
    : [];
  const saved: StubMailDraft = {
    id,
    accountId,
    to: Array.isArray(draft.to) ? draft.to.map(String) : [],
    cc: Array.isArray(draft.cc) ? draft.cc.map(String) : [],
    bcc: Array.isArray(draft.bcc) ? draft.bcc.map(String) : [],
    subject: typeof draft.subject === "string" ? draft.subject : "",
    textBody: typeof draft.textBody === "string" ? draft.textBody : "",
    htmlBody: typeof draft.htmlBody === "string" ? draft.htmlBody : "",
    attachments,
    replyContext: draft.replyContext && typeof draft.replyContext === "object"
      ? draft.replyContext as Record<string, unknown>
      : null,
    remoteDraftFolder: typeof draft.remoteDraftFolder === "string" ? draft.remoteDraftFolder : null,
    remoteDraftUid: typeof draft.remoteDraftUid === "number" ? draft.remoteDraftUid : null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  saveMailDrafts([
    saved,
    ...drafts.filter((item) => !(item.accountId === accountId && item.id === id)),
  ]);
  return saved;
}

export async function invokeMail<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    // ---------- Mail client commands (browser preview stubs) ----------
    case "mail_archive_start":

    case "mail_archive_pause":

    case "mail_archive_status":

    case "mail_archive_query":

    case "mail_archive_preview_cleanup":

    case "mail_archive_cleanup":

    case "mail_archive_list":

    case "mail_archive_read":

    case "mail_archive_export":

    case "mail_archive_attachment":

    case "mail_archive_remove":
      return mailArchiveStub(cmd, (args ?? {}) as Record<string, unknown>, mailStubSeed, stubMailBody) as T;

    case "mail_list_cached_folders": {
      return stubMailListFolders(stubMailAccountId(args as InvokeArgs | undefined), mailStubSeed) as T;
    }

    case "mail_list_cached_messages": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const limit = Math.max(0, Number((invokeArgs?.limit as number | undefined) ?? 200));
      const offset = Math.max(0, Number((invokeArgs?.offset as number | undefined) ?? 0));
      return stubMailListCached(accountId, mailStubSeed, folder, limit, offset) as T;
    }

    case "mail_sync_headers": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const folder = ((invokeArgs?.folder as string | null | undefined) ?? "INBOX") || "INBOX";
      const messages = stubMailMessages(accountId, folder);
      const limit = Math.max(1, Number((invokeArgs?.limit as number | undefined) ?? messages.length));
      const offset = Math.max(0, Number((invokeArgs?.offset as number | undefined) ?? 0));
      const page = messages.slice(offset, offset + limit);
      return {
        accountId,
        folder,
        folders: stubMailListFolders(accountId, mailStubSeed),
        messages: page,
        fetchedMessages: page.length,
        cachedBodies: page.filter((message) => message.bodyCached).length,
        syncedAt: Math.floor(Date.now() / 1000),
        offset,
        limit,
        hasMore: offset + page.length < messages.length,
      } as T;
    }

    case "mail_idle_start": {
      const invokeArgs = args as InvokeArgs | undefined;
      const folder = ((invokeArgs?.folder as string | null | undefined) ?? "INBOX") || "INBOX";
      return stubMailIdleStart(stubMailAccountId(invokeArgs), folder) as T;
    }

    case "mail_idle_stop": {
      const invokeArgs = args as InvokeArgs | undefined;
      return stubMailIdleStop(String(invokeArgs?.accountId ?? "")) as T;
    }

    case "mail_sync_folder": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const folder = ((invokeArgs?.folder as string | null | undefined) ?? "INBOX") || "INBOX";
      const mode = (invokeArgs?.mode as string | null | undefined) ?? "auto";
      const limit = Math.max(1, Number((invokeArgs?.limit as number | null | undefined) ?? 200));
      return stubMailSyncFolder(accountId, mailStubSeed, folder, mode, limit) as T;
    }

    case "mail_sync_all_folders": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const limit = Math.max(1, Number((invokeArgs?.limit as number | null | undefined) ?? 50));
      const config = invokeArgs?.config as { sync?: { subscribedOnly?: boolean } } | undefined;
      return stubMailSyncAll(accountId, mailStubSeed, limit, config?.sync?.subscribedOnly === true) as T;
    }

    case "mail_autoconfig": {
      // Browser preview: the backend's built-in table for a few domains only.
      const email = String((args as InvokeArgs | undefined)?.email ?? "");
      const domain = email.split("@")[1]?.toLowerCase() ?? "";
      const table: Record<string, [string, string, string]> = {
        "qq.com": ["custom", "imap.qq.com", "smtp.qq.com"],
        "163.com": ["custom", "imap.163.com", "smtp.163.com"],
        "gmail.com": ["gmail", "imap.gmail.com", "smtp.gmail.com"],
      };
      const hit = table[domain];
      if (!hit) return null as T;
      return {
        source: "builtin",
        provider: hit[0],
        imap: { host: hit[1], port: 993, security: "TLS" },
        smtp: { host: hit[2], port: 465, security: "TLS" },
      } as T;
    }

    case "mail_list_folders": {
      const invokeArgs = args as InvokeArgs | undefined;
      return stubMailListFolders(stubMailAccountId(invokeArgs), mailStubSeed) as T;
    }

    case "mail_set_folder_subscription": {
      const invokeArgs = args as InvokeArgs | undefined;
      return stubMailSetSubscription(
        stubMailAccountId(invokeArgs),
        mailStubSeed,
        String(invokeArgs?.folder ?? ""),
        invokeArgs?.subscribed === true,
      ) as T;
    }

    case "mail_prefetch_message_body":
      return undefined as T;

    case "mail_get_message_body": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const uid = Number((invokeArgs?.uid as number | undefined) ?? 91);
      return stubMailBody(accountId, folder, uid) as T;
    }

    case "mail_download_attachment": {
      const invokeArgs = args as InvokeArgs | undefined;
      const targetPath = (invokeArgs?.targetPath as string | undefined) ?? "attachment";
      return { path: targetPath, name: "policy.txt", contentType: "text/plain", size: 1240 } as T;
    }

    case "mail_mark_read": {
      const invokeArgs = args as InvokeArgs | undefined;
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const uids = Array.isArray(invokeArgs?.uids) ? (invokeArgs?.uids as unknown[]).map(Number) : [];
      const all = Boolean(invokeArgs?.all);
      return await stubMailMarkRead(stubMailAccountId(invokeArgs), mailStubSeed, folder, uids, all) as T;
    }

    case "mail_send_message": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const request = (invokeArgs?.request as {
        to?: string[];
        subject?: string;
        textBody?: string | null;
        inReplyTo?: string | null;
        references?: string[];
        draftId?: string | null;
      } | undefined) ?? {};
      const messageId = `<sent-${Date.now()}@taomni.local>`;
      stubMailRecordSent(`Subject: ${request.subject ?? ""}\n\n${request.textBody ?? ""}`);
      stubMailAppend(accountId, mailStubSeed, "Sent", {
        subject: request.subject ?? "",
        messageId,
        flags: ["\\Seen"],
        to: (request.to ?? []).map((address) => ({ name: address, address })),
        from: { name: "Preview User", address: "user@example.com" },
        snippet: (request.textBody ?? "").slice(0, 200),
        inReplyTo: request.inReplyTo?.replace(/^<|>$/g, "") ?? null,
        references: (request.references ?? []).map((id) => id.replace(/^<|>$/g, "")),
      });
      const drafted = request.draftId
        ? loadMailDrafts().find((draft) => draft.id === request.draftId)
        : undefined;
      if (drafted?.remoteDraftFolder && drafted.remoteDraftUid) {
        stubMailExpunge(accountId, mailStubSeed, drafted.remoteDraftFolder, drafted.remoteDraftUid);
      }
      return { accepted: true, response: "browser-preview accepted", sentCopyFolder: "Sent" } as T;
    }

    case "mail_list_filters":
      return stubListFilters(stubMailAccountId(args as InvokeArgs | undefined)) as T;

    case "mail_save_filters": {
      const invokeArgs = args as InvokeArgs | undefined;
      const filters = (invokeArgs?.filters as MailFilter[] | undefined) ?? [];
      return stubSaveFilters(stubMailAccountId(invokeArgs), mailStubSeed, filters) as T;
    }

    case "mail_apply_filters": {
      const invokeArgs = args as InvokeArgs | undefined;
      return stubApplyFilters(
        stubMailAccountId(invokeArgs),
        mailStubSeed,
        (invokeArgs?.folder as string | undefined) ?? "INBOX",
        String(invokeArgs?.trigger ?? "manual"),
        {
          uids: (invokeArgs?.uids as number[] | null | undefined) ?? null,
          filterIds: (invokeArgs?.filterIds as string[] | null | undefined) ?? null,
          trashFolder: (invokeArgs?.trashFolder as string | null | undefined) ?? null,
        },
      ) as T;
    }

    case "mail_export_filters":
      return stubListFilters(stubMailAccountId(args as InvokeArgs | undefined)).length as T;

    case "mail_import_filters":
      return stubListFilters(stubMailAccountId(args as InvokeArgs | undefined)) as T;

    case "mail_get_invite": {
      const invokeArgs = args as InvokeArgs | undefined;
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const uid = Number(invokeArgs?.uid ?? 0);
      return (stubMailFindHeader(stubMailAccountId(invokeArgs), mailStubSeed, folder, uid)?.invite ?? null) as T;
    }

    case "mail_respond_invite": {
      const invokeArgs = args as InvokeArgs | undefined;
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const uid = Number(invokeArgs?.uid ?? 0);
      const invite = stubMailFindHeader(stubMailAccountId(invokeArgs), mailStubSeed, folder, uid)?.invite;
      if (!invite) throw new Error("this message has no calendar invitation");
      const partstat = ({ accept: "ACCEPTED", tentative: "TENTATIVE", decline: "DECLINED" } as Record<string, string>)[
        String(invokeArgs?.response ?? "")
      ];
      if (!partstat) throw new Error(`unknown invitation response ${String(invokeArgs?.response)}`);
      // Like the backend: an iTIP REPLY to the organizer (not stored in Sent).
      stubMailRecordSent(`METHOD:REPLY\nUID:${invite.uid}\nATTENDEE;PARTSTAT=${partstat}:mailto:user@example.com`);
      return { partstat, sentTo: invite.organizer.email } as T;
    }

    case "mail_set_flags": {
      const invokeArgs = args as InvokeArgs | undefined;
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const uids = Array.isArray(invokeArgs?.uids) ? (invokeArgs?.uids as unknown[]).map(Number) : [];
      const add = Array.isArray(invokeArgs?.add) ? (invokeArgs?.add as string[]) : [];
      const remove = Array.isArray(invokeArgs?.remove) ? (invokeArgs?.remove as string[]) : [];
      const updated = stubMailUpdateCachedFlags(stubMailAccountId(invokeArgs), folder, uids, add, remove);
      return { folder, updated } as T;
    }

    case "mail_move_messages":

    case "mail_copy_messages":

    case "mail_delete_messages": {
      const invokeArgs = args as InvokeArgs | undefined;
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const uids = Array.isArray(invokeArgs?.uids) ? (invokeArgs?.uids as unknown[]).map(Number) : [];
      const target = (invokeArgs?.targetFolder as string | undefined) ?? null;
      const mutation = stubMailMutation(
        stubMailAccountId(invokeArgs), mailStubSeed, folder, uids,
        cmd === "mail_delete_messages" ? null : target,
        cmd === "mail_copy_messages", invokeArgs?.all === true,
        String(invokeArgs?.operationId ?? crypto.randomUUID()),
      );
      const count = mutation.completedUids.length;
      return (cmd === "mail_delete_messages" ? { folder, deleted: count, mutation } : { folder, target, count, mutation }) as T;
    }

    case "mail_search_messages": {
      const invokeArgs = args as InvokeArgs | undefined;
      return stubMailSearch(
        stubMailAccountId(invokeArgs),
        mailStubSeed,
        (invokeArgs?.query as StubMailSearchQuery | undefined) ?? {},
        "cache",
      ) as T;
    }

    case "mail_search_server": {
      const invokeArgs = args as InvokeArgs | undefined;
      return stubMailSearch(
        stubMailAccountId(invokeArgs),
        mailStubSeed,
        (invokeArgs?.query as StubMailSearchQuery | undefined) ?? {},
        "server",
        (invokeArgs?.folder as string | undefined) ?? "INBOX",
      ) as T;
    }

    case "mail_store_remote_draft": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const draftId = (invokeArgs?.draftId as string | undefined) ?? "";
      const drafts = loadMailDrafts();
      const draft = drafts.find((item) => item.accountId === accountId && item.id === draftId);
      if (!draft) throw new Error(`draft ${draftId} not found`);
      if (draft.remoteDraftFolder && draft.remoteDraftUid) {
        stubMailExpunge(accountId, mailStubSeed, draft.remoteDraftFolder, draft.remoteDraftUid);
      }
      const uid = stubMailAppend(accountId, mailStubSeed, "Drafts", {
        subject: draft.subject,
        flags: ["\\Draft", "\\Seen"],
        snippet: draft.textBody.slice(0, 200),
      });
      const stored = { ...draft, remoteDraftFolder: "Drafts", remoteDraftUid: uid };
      saveMailDrafts(drafts.map((item) => (item === draft ? stored : item)));
      return stored as T;
    }

    case "mail_discard_remote_draft": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const draftId = (invokeArgs?.draftId as string | undefined) ?? "";
      const drafts = loadMailDrafts();
      const draft = drafts.find((item) => item.accountId === accountId && item.id === draftId);
      if (!draft?.remoteDraftFolder || !draft.remoteDraftUid) return false as T;
      stubMailExpunge(accountId, mailStubSeed, draft.remoteDraftFolder, draft.remoteDraftUid);
      saveMailDrafts(drafts.map((item) => (item === draft ? { ...draft, remoteDraftFolder: null, remoteDraftUid: null } : item)));
      return true as T;
    }

    case "mail_list_drafts": {
      const accountId = stubMailAccountId(args as InvokeArgs | undefined);
      return loadMailDrafts()
        .filter((draft) => draft.accountId === accountId)
        .sort((a, b) => b.updatedAt - a.updatedAt) as T;
    }

    case "mail_save_draft": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const draft = (invokeArgs?.draft as Record<string, unknown> | undefined) ?? {};
      return stubSaveMailDraft(accountId, draft) as T;
    }

    case "mail_delete_draft": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const draftId = (invokeArgs?.draftId as string | undefined) ?? "";
      saveMailDrafts(loadMailDrafts().filter((draft) => !(draft.accountId === accountId && draft.id === draftId)));
      return undefined as T;
    }

    case "mail_index_cached_contacts": {
      return stubMailContacts(stubMailAccountId(args as InvokeArgs | undefined), "", 100).length as T;
    }

    case "mail_search_contacts": {
      const invokeArgs = args as InvokeArgs | undefined;
      const accountId = stubMailAccountId(invokeArgs);
      const query = (invokeArgs?.query as string | undefined) ?? "";
      const limit = Math.max(1, Math.min(20, Number((invokeArgs?.limit as number | undefined) ?? 8)));
      // Address book entries first, like the backend (TASK-19).
      const seen = new Set<string>();
      return [...stubAddressBookSuggestions(accountId, query, limit), ...stubMailContacts(accountId, query, limit)]
        .filter((hit) => {
          const key = hit.email.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, limit) as T;
    }

    case "mail_list_address_book":
      return stubListAddressBook(stubMailAccountId(args as InvokeArgs | undefined)) as T;

    case "mail_save_address_book_entry": {
      const invokeArgs = args as InvokeArgs | undefined;
      return stubSaveAddressBookEntry(stubMailAccountId(invokeArgs), invokeArgs?.entry as MailAddressBookEntry) as T;
    }

    case "mail_delete_address_book_entry": {
      const invokeArgs = args as InvokeArgs | undefined;
      return stubDeleteAddressBookEntry(stubMailAccountId(invokeArgs), String(invokeArgs?.uid ?? "")) as T;
    }

    case "mail_import_vcards":

    case "mail_export_vcards":
      throw new Error("vCard files need the desktop app");

    case "mail_carddav_sync":
      throw new Error("CardDAV sync needs the desktop app");

    case "mail_send_receipt": {
      const invokeArgs = args as InvokeArgs | undefined;
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const uid = Number(invokeArgs?.uid ?? 0);
      const accountId = stubMailAccountId(invokeArgs);
      const header = stubMailFindHeader(accountId, mailStubSeed, folder, uid);
      if (!header?.receiptTo) throw new Error("the sender did not ask for a read receipt");
      stubMailRecordSent(
        `To: <${header.receiptTo}>\nContent-Type: multipart/report; report-type=disposition-notification\n`
        + `Original-Message-ID: ${header.messageId}\nDisposition: ${invokeArgs?.automatic ? "automatic-action" : "manual-action"}`,
      );
      stubMailUpdateCachedFlags(accountId, folder, [uid], ["$MDNSent"], []);
      return { sentTo: header.receiptTo } as T;
    }

    case "mail_list_agenda": {
      const invokeArgs = args as InvokeArgs | undefined;
      return stubListAgenda(stubMailAccountId(invokeArgs), Number(invokeArgs?.days ?? 14)) as T;
    }

    case "mail_caldav_sync": {
      const invokeArgs = args as InvokeArgs | undefined;
      const config = invokeArgs?.config as { caldav?: { url?: string } | null } | undefined;
      return stubCalDavSync(stubMailAccountId(invokeArgs), config?.caldav?.url ?? "") as T;
    }

    case "mail_add_invite_to_calendar": {
      const invokeArgs = args as InvokeArgs | undefined;
      const folder = (invokeArgs?.folder as string | undefined) ?? "INBOX";
      const uid = Number(invokeArgs?.uid ?? 0);
      const accountId = stubMailAccountId(invokeArgs);
      const invite = stubMailFindHeader(accountId, mailStubSeed, folder, uid)?.invite;
      if (!invite) throw new Error("this message has no calendar invitation");
      return stubAddInviteToCalendar(accountId, invite, (invokeArgs?.partstat as string | null | undefined) ?? null) as T;
    }

    case "mail_test_connection": {
      return { imapOk: true, smtpOk: true, folderCount: MAIL_STUB_FOLDERS.length } as T;
    }

    case "mail_oauth_authorize": {
      return {
        tokenRef: "vault:stub-mail-oauth-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: "stub-mail-scope",
        tokenType: "Bearer",
      } as T;
    }

    case "mail_oauth_device_start": {
      const invokeArgs = args as InvokeArgs | undefined;
      const provider = (invokeArgs?.request as { provider?: string } | undefined)?.provider;
      return {
        deviceCode: "stub-device-code",
        userCode: "ABCD-EFGH",
        verificationUri: provider === "gmail" ? "https://www.google.com/device" : "https://microsoft.com/devicelogin",
        message: "Open the verification URL and enter code ABCD-EFGH.",
        expiresIn: 900,
        interval: 1,
      } as T;
    }

    case "mail_oauth_device_complete": {
      return {
        tokenRef: "vault:stub-mail-oauth-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: "stub-mail-scope",
        tokenType: "Bearer",
      } as T;
    }

    case "mail_clear_cache": {
      stubMailClearCache(stubMailAccountId(args as InvokeArgs | undefined));
      return undefined as T;
    }
    default: throw new Error(`Unhandled mail stub command: ${cmd}`);
  }
}
