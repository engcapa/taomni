import { describe, expect, it, vi } from "vitest";
import type { MailFolder, MailFolderSyncResult, MailMessageHeader } from "./mail";
import {
  MAIL_HEADER_LIMITS_EXPLICIT_KEY,
  countNewMail,
  folderHasMoreToLoad,
  mailHeaderLimitOption,
  mergeFolderMeta,
  mergeSyncedMessages,
  runFolderSyncLoop,
} from "./mailSync";

const accountId = "acct-1";

function folder(name: string, overrides: Partial<MailFolder> = {}): MailFolder {
  return {
    accountId,
    name,
    displayName: name,
    delimiter: "/",
    flags: [],
    uidValidity: 1,
    uidNext: 1,
    total: 0,
    unread: 0,
    updatedAt: 1,
    ...overrides,
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
    flags: [],
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    snippet: null,
    rawSize: 100,
    bodyCached: false,
  };
}

function stepResult(overrides: Partial<MailFolderSyncResult>): MailFolderSyncResult {
  return {
    accountId,
    folder: folder("INBOX"),
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

const sortDesc = (messages: MailMessageHeader[]) => messages.slice().sort((a, b) => b.uid - a.uid);

describe("runFolderSyncLoop", () => {
  it("repeats steps until the backend reports no more work (AC-01/AC-02)", async () => {
    const remaining = [70, 20, 0];
    const step = vi.fn(async () => {
      const left = remaining.shift() ?? 0;
      return stepResult({ fetched: 50, newUnseen: 40, remainingNew: left, more: left > 0 });
    });
    const progress: number[] = [];
    const result = await runFolderSyncLoop({
      step,
      onStep: (_result, p) => {
        progress.push(p.fetched);
      },
    });
    expect(step).toHaveBeenCalledTimes(3);
    expect(step).toHaveBeenCalledWith("auto");
    expect(result.fetched).toBe(150);
    expect(result.newUnseen).toBe(120);
    expect(result.exhausted).toBe(false);
    expect(progress).toEqual([50, 100, 150]);
  });

  it("stops at maxSteps and reports remaining work", async () => {
    const step = vi.fn(async () => stepResult({ fetched: 10, remainingNew: 99, more: true }));
    const result = await runFolderSyncLoop({ step, maxSteps: 4, mode: "backfill" });
    expect(step).toHaveBeenCalledTimes(4);
    expect(step).toHaveBeenCalledWith("backfill");
    expect(result.exhausted).toBe(true);
    expect(result.remaining).toBe(99);
  });

  it("stops before the next step once cancelled", async () => {
    let cancelled = false;
    const step = vi.fn(async () => {
      cancelled = true;
      return stepResult({ more: true, remainingNew: 5 });
    });
    const result = await runFolderSyncLoop({ step, isCancelled: () => cancelled });
    expect(step).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
  });

  it("propagates step errors to the caller", async () => {
    await expect(runFolderSyncLoop({ step: async () => { throw new Error("offline"); } }))
      .rejects.toThrow("offline");
  });
});

describe("mergeSyncedMessages", () => {
  it("does not rewrite the list after the user switched folders", () => {
    const current = [header("INBOX", 1), header("INBOX", 2)];
    expect(mergeSyncedMessages("INBOX", "Sent", current, [header("Sent", 10)], sortDesc)).toBeNull();
  });

  it("merges new headers and drops rows of other folders", () => {
    const current = [header("Sent", 9), header("INBOX", 1), header("INBOX", 2)];
    const merged = mergeSyncedMessages("INBOX", "INBOX", current, [header("INBOX", 3), header("INBOX", 2)], sortDesc);
    expect(merged?.map((message) => `${message.folder}:${message.uid}`)).toEqual(["INBOX:3", "INBOX:2", "INBOX:1"]);
  });
});

describe("folderHasMoreToLoad", () => {
  it("prefers cached rows before backfill", () => {
    expect(folderHasMoreToLoad(folder("INBOX", { cachedCount: 300, total: 300, syncComplete: true }), 200, false)).toBe(true);
  });

  it("offers backfill while older server history remains (AC-07)", () => {
    expect(folderHasMoreToLoad(folder("INBOX", { cachedCount: 200, total: 5000, syncComplete: false }), 200, false)).toBe(true);
  });

  it("stops once the span is complete even if the server total is larger (retention)", () => {
    expect(folderHasMoreToLoad(folder("INBOX", { cachedCount: 200, total: 5000, syncComplete: true }), 200, false)).toBe(false);
  });

  it("trusts the cache page probe", () => {
    expect(folderHasMoreToLoad(undefined, 0, true)).toBe(true);
    expect(folderHasMoreToLoad(undefined, 0, false)).toBe(false);
  });
});

describe("countNewMail", () => {
  it("sums new unseen mail and skips excluded folders (AC-09)", () => {
    const folders = [folder("INBOX"), folder("Sent"), folder("Work")];
    const count = countNewMail({ INBOX: 5, Sent: 3, Work: 2 }, folders, (entry) => entry.name === "Sent");
    expect(count).toBe(7);
    expect(countNewMail(undefined, folders, () => false)).toBe(0);
  });
});

describe("mergeFolderMeta", () => {
  it("replaces an existing folder and appends unknown ones", () => {
    const merged = mergeFolderMeta([folder("INBOX", { unread: 1 })], folder("INBOX", { unread: 4, lastError: null }));
    expect(merged).toHaveLength(1);
    expect(merged[0].unread).toBe(4);
    expect(mergeFolderMeta(merged, folder("Work"))).toHaveLength(2);
  });
});

describe("mailHeaderLimitOption (DEC-08)", () => {
  it("treats missing, zero and legacy implicit defaults as unlimited", () => {
    expect(mailHeaderLimitOption({}, "mailHeaderLimitPerFolder", 2000)).toBe(0);
    expect(mailHeaderLimitOption({ mailHeaderLimitPerFolder: "0" }, "mailHeaderLimitPerFolder", 2000)).toBe(0);
    expect(mailHeaderLimitOption({ mailHeaderLimitPerFolder: "2000" }, "mailHeaderLimitPerFolder", 2000)).toBe(0);
    expect(mailHeaderLimitOption({ mailHeaderRetentionDays: 30 }, "mailHeaderRetentionDays", 30)).toBe(0);
  });

  it("keeps values the user chose", () => {
    expect(mailHeaderLimitOption({ mailHeaderLimitPerFolder: "5000" }, "mailHeaderLimitPerFolder", 2000)).toBe(5000);
    expect(mailHeaderLimitOption(
      { mailHeaderRetentionDays: "30", [MAIL_HEADER_LIMITS_EXPLICIT_KEY]: true },
      "mailHeaderRetentionDays",
      30,
    )).toBe(30);
  });
});
