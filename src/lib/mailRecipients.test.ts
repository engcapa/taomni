import { describe, expect, it } from "vitest";
import type { MailMessageHeader } from "./mail";
import {
  addRecipientsUnique,
  currentDomainSuggestion,
  extractDefaultMailDomain,
  parseRecipientsText,
  searchCachedMessageContacts,
} from "./mailRecipients";

describe("mailRecipients", () => {
  it("parses bare, display-name, and pasted recipient lists", () => {
    expect(parseRecipientsText("Ada <ada@example.com>, bob@example.com; carol@example.com")).toEqual([
      { name: "Ada", email: "ada@example.com" },
      { name: null, email: "bob@example.com" },
      { name: null, email: "carol@example.com" },
    ]);
    expect(parseRecipientsText("\"Li, Si\" <si.li@example.com>")).toEqual([
      { name: "Li, Si", email: "si.li@example.com" },
    ]);
  });

  it("dedupes recipients by normalized email", () => {
    expect(addRecipientsUnique(
      [{ name: "Ada", email: "Ada@Example.com" }],
      [{ name: "Ada Lovelace", email: "ada@example.com" }, { name: null, email: "bob@example.com" }],
    )).toEqual([
      { name: "Ada", email: "Ada@Example.com" },
      { name: null, email: "bob@example.com" },
    ]);
  });

  it("extracts and applies the current account domain fallback", () => {
    const domain = extractDefaultMailDomain(["san.zhang@yourmail.com"]);
    expect(domain).toBe("yourmail.com");
    expect(currentDomainSuggestion("si.li@", domain)?.email).toBe("si.li@yourmail.com");
    expect(currentDomainSuggestion("si.li@y", domain)?.email).toBe("si.li@yourmail.com");
    expect(currentDomainSuggestion("si.li@gmail", domain)).toBeNull();
  });

  it("searches cached message contacts and excludes selected recipients", () => {
    const messages: MailMessageHeader[] = [{
      accountId: "acct",
      folder: "INBOX",
      uid: 1,
      messageId: "m1",
      subject: "Hello",
      from: { name: "Si Li", address: "si.li@yourmail.com" },
      to: [{ name: "San Zhang", address: "san.zhang@yourmail.com" }],
      cc: [],
      dateTs: 1_800_000_000,
      flags: [],
      hasAttachments: false,
      attachmentCount: 0,
      attachments: [],
      snippet: "hello",
      rawSize: null,
      bodyCached: false,
    }];

    expect(searchCachedMessageContacts(messages, "si")[0]).toMatchObject({
      name: "Si Li",
      email: "si.li@yourmail.com",
    });
    expect(searchCachedMessageContacts(messages, "si", [{ name: null, email: "si.li@yourmail.com" }])).toEqual([]);
  });
});
