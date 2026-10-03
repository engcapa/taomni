import { describe, expect, it } from "vitest";
import type { MailMessageHeader } from "./mail";
import { isJunk, messageTags, toggleKeywordPlan } from "./mailTags";

function message(flags: string[]): MailMessageHeader {
  return {
    accountId: "a",
    folder: "INBOX",
    uid: 1,
    subject: "s",
    to: [],
    cc: [],
    flags,
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    bodyCached: false,
  };
}

describe("mail tags", () => {
  it("reads Thunderbird label keywords case-insensitively", () => {
    expect(messageTags(message(["\\Seen", "$Label1", "$label4"])).map((tag) => tag.label)).toEqual(["Important", "To Do"]);
  });

  it("toggles a keyword on unless every target already has it", () => {
    expect(toggleKeywordPlan([message(["$label2"]), message([])], "$label2")).toEqual({ add: ["$label2"], remove: [], enable: true });
    expect(toggleKeywordPlan([message(["$label2"])], "$label2")).toEqual({ add: [], remove: ["$label2"], enable: false });
  });

  it("treats $NotJunk as overriding $Junk", () => {
    expect(isJunk(message(["$Junk"]))).toBe(true);
    expect(isJunk(message(["$Junk", "$NotJunk"]))).toBe(false);
  });
});
