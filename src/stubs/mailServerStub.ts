// Browser-preview model of an IMAP server plus the desktop mail cache.
//
// It mirrors the gap-free sync contract of src-tauri/src/mail/sync.rs closely
// enough for UI automation: the cache only changes through mail_sync_* steps,
// each step fetches at most `limit` headers newest-first and reports `more`.
// `window.__taomniQaMail` lets QA cases deliver/expunge/re-flag server mail
// "from another client" while the UI runs. This proves renderer orchestration
// only; real IMAP behavior is covered by the Rust tests and native cases.

import { emit } from "./tauri-event";

type StubMailHeader = {
  accountId: string;
  folder: string;
  uid: number;
  messageId: string;
  subject: string;
  from: { name: string; address: string };
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  dateTs: number;
  flags: string[];
  hasAttachments: boolean;
  attachmentCount: number;
  attachments: { name: string; contentType: string; size: number }[];
  snippet: string;
  rawSize: number;
  bodyCached: boolean;
  inReplyTo?: string | null;
  references?: string[];
  listUnsubscribe?: { uris: string[]; oneClick: boolean } | null;
  /** Parsed iTIP REQUEST served by mail_get_invite (TASK-20). */
  invite?: StubMailInvite | null;
};

export type StubMailInvite = {
  method: string;
  uid: string;
  sequence: number;
  summary: string;
  location: string | null;
  start: { local: string; epoch: number; tzid: string; allDay: boolean };
  end: { local: string; epoch: number; tzid: string; allDay: boolean };
  organizer: { email: string; name: string; partstat: string };
  attendees: { email: string; name: string | null; partstat: string }[];
  status: string | null;
  ics: string;
};

/** Text of messages the stub "sent" over SMTP, for QA assertions. */
const sentTexts: string[] = [];

export function stubMailRecordSent(text: string) {
  sentTexts.push(text);
}

type StubFolderMeta = { name: string; displayName: string };

interface StubFolderState {
  server: Map<number, StubMailHeader>;
  cache: Map<number, StubMailHeader>;
  uidNext: number;
  low: number | null;
  high: number | null;
  complete: boolean;
}

interface StubAccountState {
  folders: Map<string, StubFolderState>;
  meta: StubFolderMeta[];
  /** Folders missing from LSUB (TASK-10); everything else is subscribed. */
  unsubscribed: Set<string>;
}

const accounts = new Map<string, StubAccountState>();
const deliveredTotals = new Map<string, number>();

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

function account(accountId: string, seed: Seed): StubAccountState {
  let state = accounts.get(accountId);
  if (state) return state;
  const { meta, messages } = seed(accountId);
  state = { folders: new Map(), meta, unsubscribed: new Set() };
  for (const folder of meta) {
    const seeded = messages(folder.name);
    const server = new Map(seeded.map((message) => [message.uid, { ...message }]));
    const uids = seeded.map((message) => message.uid);
    state.folders.set(folder.name, {
      server,
      cache: new Map(seeded.map((message) => [message.uid, { ...message }])),
      uidNext: Math.max(100, ...uids.map((uid) => uid + 1)),
      low: uids.length ? Math.min(...uids) : 1,
      high: uids.length ? Math.max(...uids) : 0,
      complete: true,
    });
  }
  accounts.set(accountId, state);
  return state;
}

function folderState(state: StubAccountState, name: string): StubFolderState {
  let folder = state.folders.get(name);
  if (!folder) {
    folder = { server: new Map(), cache: new Map(), uidNext: 1, low: 1, high: 0, complete: true };
    state.folders.set(name, folder);
    state.meta.push({ name, displayName: name });
  }
  return folder;
}

function isUnseen(message: StubMailHeader): boolean {
  return !message.flags.some((flag) => flag.toLowerCase() === "\\seen");
}

function folderPayload(accountId: string, state: StubAccountState, meta: StubFolderMeta) {
  const folder = folderState(state, meta.name);
  return {
    accountId,
    name: meta.name,
    displayName: meta.displayName,
    delimiter: "/",
    flags: state.unsubscribed.has(meta.name) ? [] : ["\\Subscribed"],
    uidValidity: 1,
    uidNext: folder.uidNext,
    total: folder.server.size,
    unread: [...folder.server.values()].filter(isUnseen).length,
    updatedAt: nowTs(),
    syncLowUid: folder.low,
    syncHighUid: folder.high,
    syncComplete: folder.complete,
    cachedCount: folder.cache.size,
    lastError: null,
  };
}

export type Seed = (accountId: string) => {
  meta: StubFolderMeta[];
  messages: (folder: string) => StubMailHeader[];
};

export function stubMailListFolders(accountId: string, seed: Seed) {
  const state = account(accountId, seed);
  return state.meta.map((meta) => folderPayload(accountId, state, meta));
}

export function stubMailListCached(accountId: string, seed: Seed, folder: string, limit: number, offset: number) {
  const state = account(accountId, seed);
  const rows = [...folderState(state, folder).cache.values()]
    .sort((a, b) => (b.dateTs - a.dateTs) || (b.uid - a.uid));
  return rows.slice(offset, offset + limit);
}

export function stubMailFindHeader(accountId: string, seed: Seed, folder: string, uid: number) {
  const state = account(accountId, seed);
  const entry = folderState(state, folder);
  return entry.cache.get(uid) ?? entry.server.get(uid) ?? null;
}

export function stubMailSyncFolder(
  accountId: string,
  seed: Seed,
  folderName: string,
  mode: string,
  limit: number,
) {
  const state = account(accountId, seed);
  const folder = folderState(state, folderName);
  const serverUids = [...folder.server.keys()].sort((a, b) => a - b);
  let fetched: StubMailHeader[] = [];
  let remaining = 0;
  let more = false;
  let newUnseen = 0;
  let vanished = 0;
  let flagsUpdated = 0;
  let resultMode = mode === "auto" ? "catchup" : mode;
  if (mode === "backfill") {
    const older = serverUids.filter((uid) => uid < (folder.low ?? 1));
    const block = older.slice(-limit);
    fetched = block.map((uid) => ({ ...folder.server.get(uid)! }));
    if (block.length) folder.low = block[0];
    folder.complete = older.length <= limit;
    more = !folder.complete;
  } else if (mode === "reconcile" || mode === "reconcileFull") {
    for (const uid of [...folder.cache.keys()]) {
      const server = folder.server.get(uid);
      if (!server) {
        folder.cache.delete(uid);
        vanished += 1;
      } else if (JSON.stringify(server.flags) !== JSON.stringify(folder.cache.get(uid)!.flags)) {
        folder.cache.set(uid, { ...server });
        flagsUpdated += 1;
      }
    }
  } else {
    const high = folder.high ?? 0;
    const missing = serverUids.filter((uid) => uid > high && !folder.cache.has(uid));
    const take = missing.slice(-limit);
    fetched = take.map((uid) => ({ ...folder.server.get(uid)! }));
    remaining = missing.length - take.length;
    more = remaining > 0;
    newUnseen = fetched.filter(isUnseen).length;
    if (!more && serverUids.length) folder.high = Math.max(high, serverUids[serverUids.length - 1]);
    resultMode = "catchup";
  }
  for (const message of fetched) folder.cache.set(message.uid, message);
  const meta = state.meta.find((entry) => entry.name === folderName) ?? { name: folderName, displayName: folderName };
  return {
    accountId,
    folder: folderPayload(accountId, state, meta),
    mode: resultMode,
    messages: fetched.sort((a, b) => b.uid - a.uid),
    fetched: fetched.length,
    newUnseen,
    vanished,
    flagsUpdated,
    remainingNew: remaining,
    more,
    syncComplete: folder.complete,
    uidValidityReset: false,
    syncedAt: nowTs(),
  };
}

export function stubMailSetSubscription(accountId: string, seed: Seed, folder: string, subscribed: boolean) {
  const state = account(accountId, seed);
  if (subscribed) state.unsubscribed.delete(folder);
  else state.unsubscribed.add(folder);
  return stubMailListFolders(accountId, seed);
}

export function stubMailSyncAll(accountId: string, seed: Seed, limit: number, subscribedOnly = false) {
  const state = account(accountId, seed);
  const newUnseenByFolder: Record<string, number> = {};
  const pendingFolders: string[] = [];
  let fetchedMessages = 0;
  for (const meta of state.meta) {
    if (subscribedOnly && meta.name.toUpperCase() !== "INBOX" && state.unsubscribed.has(meta.name)) continue;
    const step = stubMailSyncFolder(accountId, seed, meta.name, "auto", limit);
    fetchedMessages += step.fetched;
    if (step.newUnseen) newUnseenByFolder[meta.name] = step.newUnseen;
    if (step.more) pendingFolders.push(meta.name);
    else stubMailSyncFolder(accountId, seed, meta.name, "reconcile", limit);
  }
  return {
    accountId,
    folders: stubMailListFolders(accountId, seed),
    fetchedMessages,
    newMessages: Object.values(newUnseenByFolder).reduce((sum, count) => sum + count, 0),
    newUnseenByFolder,
    failedFolders: [],
    pendingFolders,
    cachedBodies: 0,
    syncedAt: nowTs(),
  };
}

export interface StubMailSearchQuery {
  text?: string;
  folder?: string | null;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  withAttachments?: boolean;
  limit?: number;
}

/** Browser model of the local FTS index (cache) or IMAP SEARCH (server). */
export function stubMailSearch(
  accountId: string,
  seed: Seed,
  query: StubMailSearchQuery,
  source: "cache" | "server",
  serverFolder?: string,
) {
  const state = account(accountId, seed);
  const terms = (query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const folders = source === "server"
    ? [serverFolder ?? "INBOX"]
    : query.folder ? [query.folder] : [...state.folders.keys()];
  const hits: StubMailHeader[] = [];
  for (const name of folders) {
    const entry = folderState(state, name);
    const rows = source === "server" ? entry.server : entry.cache;
    for (const message of rows.values()) {
      const haystack = [
        message.subject,
        message.from?.name,
        message.from?.address,
        message.snippet,
        ...message.to.map((to) => `${to.name} ${to.address}`),
      ].join(" ").toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) continue;
      if (query.unreadOnly && !isUnseen(message)) continue;
      if (query.flaggedOnly && !message.flags.some((flag) => flag.toLowerCase() === "\\flagged")) continue;
      if (query.withAttachments && !message.hasAttachments) continue;
      hits.push({ ...message });
    }
  }
  return hits
    .sort((a, b) => (b.dateTs - a.dateTs) || (b.uid - a.uid))
    .slice(0, Math.max(1, query.limit ?? 500));
}

/** Browser model of IMAP APPEND (Sent copies, server drafts). */
export function stubMailAppend(accountId: string, seed: Seed, folderName: string, message: Partial<StubMailHeader>): number {
  const state = account(accountId, seed);
  const folder = folderState(state, folderName);
  const uid = folder.uidNext;
  folder.uidNext += 1;
  folder.server.set(uid, {
    ...templateMessage(accountId, folderName, uid, message.subject ?? "(no subject)"),
    ...message,
    accountId,
    folder: folderName,
    uid,
  });
  return uid;
}

export function stubMailExpunge(accountId: string, seed: Seed, folderName: string, uid: number) {
  folderState(account(accountId, seed), folderName).server.delete(uid);
}

export function stubMailClearCache(accountId: string) {
  const state = accounts.get(accountId);
  if (!state) return;
  for (const folder of state.folders.values()) {
    folder.cache.clear();
    folder.low = null;
    folder.high = null;
    folder.complete = false;
  }
}

/** Browser model of UID MOVE/COPY and delete (STORE \Deleted + EXPUNGE). */
export function stubMailTransfer(
  accountId: string,
  seed: Seed,
  folderName: string,
  uids: number[],
  target: string | null,
  keepSource: boolean,
): number {
  const state = account(accountId, seed);
  const source = folderState(state, folderName);
  const dest = target ? folderState(state, target) : null;
  let count = 0;
  for (const uid of uids) {
    const message = source.server.get(uid);
    if (!message) continue;
    count += 1;
    if (dest) {
      const newUid = dest.uidNext;
      dest.uidNext += 1;
      dest.server.set(newUid, { ...message, folder: target!, uid: newUid });
    }
    if (!keepSource) {
      source.server.delete(uid);
      source.cache.delete(uid);
    }
  }
  return count;
}

export function stubMailUpdateCachedFlags(accountId: string, folder: string, uids: number[], add: string[], remove: string[]) {
  const state = accounts.get(accountId);
  const entry = state?.folders.get(folder);
  if (!entry) return 0;
  let updated = 0;
  for (const uid of uids) {
    for (const map of [entry.cache, entry.server]) {
      const message = map.get(uid);
      if (!message) continue;
      message.flags = [...message.flags.filter((flag) => !remove.includes(flag)), ...add.filter((flag) => !message.flags.includes(flag))];
    }
    updated += 1;
  }
  return updated;
}

function templateMessage(accountId: string, folder: string, uid: number, subject: string): StubMailHeader {
  const offset = deliveredTotals.get(accountId) ?? 0;
  deliveredTotals.set(accountId, offset + 1);
  return {
    accountId,
    folder,
    uid,
    messageId: `<qa-${uid}@taomni.local>`,
    subject,
    from: { name: "QA Sender", address: "qa-sender@example.com" },
    to: [{ name: "Preview User", address: "user@example.com" }],
    cc: [],
    // Newer deliveries sort first; keep them ahead of the seeded samples.
    dateTs: nowTs() + offset,
    flags: [],
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    snippet: `Delivered while the mail tab was closed: ${subject}`,
    rawSize: 2048,
    bodyCached: false,
  };
}

/** Accounts whose tab holds an IDLE watcher (TASK-12), keyed by account id. */
const idleWatchers = new Map<string, string>();

function idleNotify(accountId: string, folder: string, kind: string) {
  void emit("mail://idle", { accountId, folder, kind });
}

export function stubMailIdleStart(accountId: string, folder: string): boolean {
  idleWatchers.set(accountId, folder);
  idleNotify(accountId, folder, "ready");
  return true;
}

export function stubMailIdleStop(accountId: string): boolean {
  return idleWatchers.delete(accountId);
}

function idleChanged(accountId: string, folder: string) {
  if (idleWatchers.get(accountId) === folder) {
    // Like a server push: asynchronous, after the change is visible.
    window.setTimeout(() => idleNotify(accountId, folder, "changed"), 50);
  }
}

export interface StubMailQaControl {
  deliver: (accountId: string, folder: string, count: number, prefix?: string, thread?: boolean, listUnsubscribe?: string | null, invite?: string | null) => number[];
  expunge: (accountId: string, folder: string, uids: number[]) => void;
  setFlags: (accountId: string, folder: string, uid: number, flags: string[]) => void;
  observe: (accountId: string, folder: string) => { server: number[]; cache: number[] };
  unseen: (accountId: string, folder: string) => number;
  accounts: () => string[];
  idleClients: () => number;
  smtpContains: (text: string) => boolean;
}

function stubInvite(summary: string, uid: string): StubMailInvite {
  const start = nowTs() + 86_400;
  const time = (epoch: number) => ({
    local: new Date(epoch * 1000).toISOString().slice(0, 16),
    epoch,
    tzid: "UTC",
    allDay: false,
  });
  return {
    method: "REQUEST",
    uid,
    sequence: 0,
    summary,
    location: "QA room",
    start: time(start),
    end: time(start + 3600),
    organizer: { email: "qa-sender@example.com", name: "QA Sender", partstat: "ACCEPTED" },
    attendees: [{ email: "user@example.com", name: "Preview User", partstat: "NEEDS-ACTION" }],
    status: null,
    ics: ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${summary}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"),
  };
}

export function installStubMailQaControl(seed: Seed): void {
  const control: StubMailQaControl = {
    deliver(accountId, folderName, count, prefix = "QA", thread = false, listUnsubscribe = null, invite = null) {
      const state = account(accountId, seed);
      const folder = folderState(state, folderName);
      const uids: number[] = [];
      const ancestry: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const uid = folder.uidNext;
        folder.uidNext += 1;
        const message = templateMessage(accountId, folderName, uid, `${prefix} ${String(index + 1).padStart(4, "0")}`);
        if (thread && ancestry.length > 0) {
          message.inReplyTo = ancestry[ancestry.length - 1];
          message.references = [...ancestry];
        }
        if (listUnsubscribe) message.listUnsubscribe = { uris: [listUnsubscribe], oneClick: false };
        if (invite) {
          message.invite = stubInvite(invite, message.messageId.replace(/^<|>$/g, ""));
          message.attachments = [{ name: "invite.ics", contentType: "text/calendar", size: 420 }];
          message.attachmentCount = 1;
        }
        ancestry.push(message.messageId.replace(/^<|>$/g, ""));
        folder.server.set(uid, message);
        uids.push(uid);
      }
      idleChanged(accountId, folderName);
      return uids;
    },
    expunge(accountId, folderName, uids) {
      const folder = folderState(account(accountId, seed), folderName);
      for (const uid of uids) folder.server.delete(uid);
      idleChanged(accountId, folderName);
    },
    setFlags(accountId, folderName, uid, flags) {
      const message = folderState(account(accountId, seed), folderName).server.get(uid);
      if (message) message.flags = [...flags];
      idleChanged(accountId, folderName);
    },
    observe(accountId, folderName) {
      const folder = folderState(account(accountId, seed), folderName);
      return {
        server: [...folder.server.keys()].sort((a, b) => a - b),
        cache: [...folder.cache.keys()].sort((a, b) => a - b),
      };
    },
    idleClients() {
      return idleWatchers.size;
    },
    smtpContains(text) {
      return sentTexts.some((sent) => sent.includes(text));
    },
    unseen(accountId, folderName) {
      return [...folderState(account(accountId, seed), folderName).server.values()].filter(isUnseen).length;
    },
    accounts: () => [...accounts.keys()],
  };
  (window as unknown as { __taomniQaMail?: StubMailQaControl }).__taomniQaMail = control;
}
