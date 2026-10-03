import { describe, expect, it } from "vitest";
import type { MailFolder, MailMessageHeader } from "./mail";
import { accountLabel, isStarred, mergeUnified, unifiedFolderFor, unifiedKey } from "./mailUnified";

function folder(name: string, flags: string[] = [], displayName = name): MailFolder {
  return { accountId: "a", name, displayName, flags, updatedAt: 0, syncComplete: true };
}

function message(uid: number, dateTs: number | null, flags: string[] = []): MailMessageHeader {
  return {
    accountId: "a",
    folder: "INBOX",
    uid,
    subject: `m${uid}`,
    to: [],
    cc: [],
    dateTs,
    flags,
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    bodyCached: false,
    references: [],
  } as MailMessageHeader;
}

describe("mailUnified", () => {
  it("finds each account's folder for a unified view", () => {
    const folders = [folder("INBOX"), folder("[Gmail]/Sent Mail", ["\\Sent"]), folder("草稿箱"), folder("Deleted Items")];
    expect(unifiedFolderFor(folders, "inbox")).toBe("INBOX");
    expect(unifiedFolderFor(folders, "sent")).toBe("[Gmail]/Sent Mail");
    expect(unifiedFolderFor(folders, "drafts")).toBe("草稿箱");
    expect(unifiedFolderFor(folders, "trash")).toBe("Deleted Items");
    expect(unifiedFolderFor(folders, "sent", { sent: "Outbox copies" })).toBe("Outbox copies");
    expect(unifiedFolderFor([], "inbox")).toBe("INBOX");
    expect(unifiedFolderFor([folder("INBOX")], "drafts")).toBeNull();
  });

  it("merges accounts newest first and keeps keys distinct", () => {
    const a = [message(1, 300), message(2, 100)].map((m) => ({ accountId: "a", message: m }));
    const b = [message(1, 200), message(3, null)].map((m) => ({ accountId: "b", message: m }));
    const merged = mergeUnified([a, b]);
    expect(merged.map((entry) => `${entry.accountId}${entry.message.uid}`)).toEqual(["a1", "b1", "a2", "b3"]);
    expect(new Set(merged.map(unifiedKey)).size).toBe(4);
    expect(mergeUnified([a, b], 2)).toHaveLength(2);
  });

  it("labels and flags", () => {
    expect(isStarred(message(1, 0, ["\\Flagged"]))).toBe(true);
    expect(isStarred(message(1, 0, ["\\Seen"]))).toBe(false);
    expect(accountLabel({ displayName: " ", emailAddress: "me@example.com", sessionId: "s" })).toBe("me@example.com");
  });
});
