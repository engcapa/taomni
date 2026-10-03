import type { MailMessageHeader } from "./mail";

/**
 * Conversation threading from Message-ID / In-Reply-To / References (the
 * strict, header-only threading Thunderbird uses by default; no subject
 * guessing). Messages whose ancestors are not loaded still join the thread of
 * any other message that shares an ancestor id.
 */
export interface MailThread {
  key: string;
  /** Chronological (oldest first). */
  messages: MailMessageHeader[];
  newestTs: number;
  unread: number;
}

export interface MailThreadRow {
  message: MailMessageHeader;
  threadKey: string;
  depth: number;
  /** First visible row of the thread (carries the expand toggle). */
  isRoot: boolean;
  threadSize: number;
  threadUnread: number;
  expanded: boolean;
}

function normalizeId(id: string | null | undefined): string | null {
  const value = id?.trim().replace(/^<|>$/g, "").toLowerCase();
  return value ? value : null;
}

function messageKey(message: MailMessageHeader): string {
  return `${message.folder}:${message.uid}`;
}

function unread(message: MailMessageHeader): boolean {
  return !message.flags.some((flag) => flag.toLowerCase().includes("seen"));
}

export function buildMailThreads(messages: readonly MailMessageHeader[]): MailThread[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const ensure = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };

  const nodeOf = new Map<string, string>();
  for (const message of messages) {
    const own = normalizeId(message.messageId) ?? `local:${messageKey(message)}`;
    ensure(own);
    nodeOf.set(messageKey(message), own);
    const ancestry = [...(message.references ?? []), message.inReplyTo ?? ""]
      .map(normalizeId)
      .filter((id): id is string => Boolean(id));
    for (const id of ancestry) {
      ensure(id);
      union(id, own);
    }
  }

  const groups = new Map<string, MailMessageHeader[]>();
  for (const message of messages) {
    const root = find(nodeOf.get(messageKey(message))!);
    const list = groups.get(root);
    if (list) list.push(message);
    else groups.set(root, [message]);
  }

  const threads: MailThread[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => ((a.dateTs ?? 0) - (b.dateTs ?? 0)) || (a.uid - b.uid));
    threads.push({
      key,
      messages: list,
      newestTs: Math.max(...list.map((message) => message.dateTs ?? 0)),
      unread: list.filter(unread).length,
    });
  }
  threads.sort((a, b) => (b.newestTs - a.newestTs) || b.key.localeCompare(a.key));
  return threads;
}

/** Depth of each message inside its thread from its parent chain. */
function threadDepths(thread: MailThread): Map<string, number> {
  const byId = new Map<string, MailMessageHeader>();
  for (const message of thread.messages) {
    const id = normalizeId(message.messageId);
    if (id) byId.set(id, message);
  }
  const depths = new Map<string, number>();
  const depthOf = (message: MailMessageHeader, guard = 0): number => {
    const key = messageKey(message);
    const known = depths.get(key);
    if (known !== undefined) return known;
    const parentId = normalizeId(message.inReplyTo)
      ?? normalizeId((message.references ?? [])[(message.references ?? []).length - 1]);
    const parentMessage = parentId ? byId.get(parentId) : undefined;
    const depth = parentMessage && parentMessage !== message && guard < 50
      ? depthOf(parentMessage, guard + 1) + 1
      : 0;
    depths.set(key, depth);
    return depth;
  };
  for (const message of thread.messages) depthOf(message);
  return depths;
}

/**
 * Rows for a threaded list. Collapsed threads show their newest message;
 * expanded threads show every message in order with reply depth.
 */
export function flattenMailThreads(
  threads: readonly MailThread[],
  expanded: ReadonlySet<string>,
): MailThreadRow[] {
  const rows: MailThreadRow[] = [];
  for (const thread of threads) {
    const isExpanded = expanded.has(thread.key) && thread.messages.length > 1;
    const base = {
      threadKey: thread.key,
      threadSize: thread.messages.length,
      threadUnread: thread.unread,
      expanded: isExpanded,
    };
    if (!isExpanded) {
      rows.push({ ...base, message: thread.messages[thread.messages.length - 1], depth: 0, isRoot: true });
      continue;
    }
    const depths = threadDepths(thread);
    thread.messages.forEach((message, index) => {
      rows.push({
        ...base,
        message,
        depth: Math.min(6, depths.get(messageKey(message)) ?? 0),
        isRoot: index === 0,
      });
    });
  }
  return rows;
}
