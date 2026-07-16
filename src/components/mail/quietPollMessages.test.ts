import { describe, expect, it } from "vitest";
import type { MailFolder, MailMessageHeader } from "../../lib/mail";
import { applyQuietPollMessages } from "./MailClientTab";

const accountId = "acct-1";

function folder(name: string, total: number): MailFolder {
  return {
    accountId,
    name,
    displayName: name,
    delimiter: "/",
    flags: [],
    uidValidity: 1,
    uidNext: total + 1,
    total,
    unread: 0,
    updatedAt: 1,
  };
}

function header(folderName: string, uid: number): MailMessageHeader {
  return {
    accountId,
    folder: folderName,
    uid,
    messageId: `${uid}@example.com`,
    subject: `Message ${uid}`,
    from: { name: "A", address: "a@example.com" },
    to: [],
    cc: [],
    dateTs: 1_700_000_000 + uid,
    flags: ["\\Seen"],
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    snippet: `snippet ${uid}`,
    rawSize: 100,
    bodyCached: false,
  };
}

describe("applyQuietPollMessages", () => {
  it("skips message rewrite when the user left the polled folder", () => {
    const current = [header("INBOX", 1), header("INBOX", 2)];
    const polled = [header("Sent", 10)];
    const result = applyQuietPollMessages(
      "INBOX",
      "Sent",
      current,
      polled,
      [folder("INBOX", 2), folder("Sent", 10)],
      true,
    );
    expect(result.applyMessages).toBe(false);
    expect(result.messages).toEqual(current);
  });

  it("merges quiet poll headers and ignores offset-0 server hasMore when already fully loaded", () => {
    // User already paged to 100 messages; quiet poll only returns the latest 50
    // with hasMore=true (offset=0 always reports more when total > batch).
    const alreadyLoaded = Array.from({ length: 100 }, (_, i) => header("INBOX", i + 1));
    const quietPage = Array.from({ length: 50 }, (_, i) => header("INBOX", 51 + i));
    const folders = [folder("INBOX", 100)];
    const result = applyQuietPollMessages(
      "INBOX",
      "INBOX",
      alreadyLoaded,
      quietPage,
      folders,
      true, // server offset=0 hasMore — must not re-enable load-more
    );
    expect(result.applyMessages).toBe(true);
    expect(result.messages.length).toBe(100);
    // total=100 and loaded=100 → no more pages even though server said hasMore
    expect(result.hasMore).toBe(false);
  });

  it("reports hasMore when post-merge count is below folder total", () => {
    const alreadyLoaded = Array.from({ length: 40 }, (_, i) => header("INBOX", i + 1));
    const quietPage = Array.from({ length: 50 }, (_, i) => header("INBOX", 10 + i));
    const folders = [folder("INBOX", 200)];
    const result = applyQuietPollMessages(
      "INBOX",
      "INBOX",
      alreadyLoaded,
      quietPage,
      folders,
      true,
    );
    expect(result.applyMessages).toBe(true);
    expect(result.messages.length).toBeGreaterThan(40);
    expect(result.hasMore).toBe(true);
  });

  it("uses server hasMore only when merge size does not exceed the quiet page", () => {
    // Fresh list: no prior pages, quiet returns full batch with hasMore, no total.
    const quietPage = Array.from({ length: 50 }, (_, i) => header("INBOX", i + 1));
    const folders = [folder("INBOX", 0)]; // total unknown / 0 → folderHasMore false
    folders[0] = { ...folders[0], total: null };
    const result = applyQuietPollMessages(
      "INBOX",
      "INBOX",
      [],
      quietPage,
      folders,
      true,
    );
    expect(result.applyMessages).toBe(true);
    expect(result.messages.length).toBe(50);
    expect(result.hasMore).toBe(true);
  });
});
