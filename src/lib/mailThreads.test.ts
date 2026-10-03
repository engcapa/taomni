import { describe, expect, it } from "vitest";
import type { MailMessageHeader } from "./mail";
import { buildMailThreads, flattenMailThreads } from "./mailThreads";

function message(
  uid: number,
  messageId: string | null,
  options: { inReplyTo?: string; references?: string[]; dateTs?: number; seen?: boolean } = {},
): MailMessageHeader {
  return {
    accountId: "acct",
    folder: "INBOX",
    uid,
    messageId,
    subject: `m${uid}`,
    from: null,
    to: [],
    cc: [],
    dateTs: options.dateTs ?? uid,
    flags: options.seen ? ["\\Seen"] : [],
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    snippet: null,
    rawSize: null,
    bodyCached: false,
    inReplyTo: options.inReplyTo ?? null,
    references: options.references ?? [],
  };
}

describe("buildMailThreads", () => {
  it("groups replies by In-Reply-To and References, newest thread first", () => {
    const threads = buildMailThreads([
      message(1, "a@x", { seen: true }),
      message(2, "b@x", { inReplyTo: "<a@x>", references: ["<a@x>"] }),
      message(3, "lonely@x", { dateTs: 10 }),
      message(4, "c@x", { references: ["a@x", "b@x"], inReplyTo: "b@x", dateTs: 20 }),
    ]);
    expect(threads.map((thread) => thread.messages.map((m) => m.uid))).toEqual([[1, 2, 4], [3]]);
    expect(threads[0].unread).toBe(2);
  });

  it("joins siblings whose shared parent is not loaded", () => {
    const threads = buildMailThreads([
      message(5, "r1@x", { inReplyTo: "missing@x" }),
      message(6, "r2@x", { references: ["missing@x"] }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].messages.map((m) => m.uid)).toEqual([5, 6]);
  });

  it("keeps messages without ids apart", () => {
    expect(buildMailThreads([message(7, null), message(8, null)])).toHaveLength(2);
  });
});

describe("flattenMailThreads", () => {
  const threads = buildMailThreads([
    message(1, "a@x"),
    message(2, "b@x", { inReplyTo: "a@x" }),
    message(3, "c@x", { inReplyTo: "b@x" }),
  ]);

  it("collapses a thread to its newest message", () => {
    const rows = flattenMailThreads(threads, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ threadSize: 3, isRoot: true, expanded: false });
    expect(rows[0].message.uid).toBe(3);
  });

  it("expands with reply depth", () => {
    const rows = flattenMailThreads(threads, new Set([threads[0].key]));
    expect(rows.map((row) => [row.message.uid, row.depth, row.isRoot])).toEqual([
      [1, 0, true],
      [2, 1, false],
      [3, 2, false],
    ]);
  });
});
