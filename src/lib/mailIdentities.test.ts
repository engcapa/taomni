import { describe, expect, it } from "vitest";
import type { MailMessageHeader } from "./mail";
import type { MailTabInfo } from "../types";
import {
  identityFromHeader,
  mailIdentities,
  ownIdentityAddresses,
  parseMailIdentities,
  pickReplyIdentity,
  swapSignature,
} from "./mailIdentities";

const info = {
  sessionId: "acct",
  emailAddress: "me@example.com",
  displayName: "Me",
  replyTo: null,
  signature: "Me",
  identities: [
    { id: "alias", name: "Support", email: "support@example.com", replyTo: "help@example.com", signature: "Support team" },
  ],
} as unknown as MailTabInfo;

function header(to: string[], cc: string[] = []): MailMessageHeader {
  return {
    accountId: "acct",
    folder: "INBOX",
    uid: 1,
    subject: "s",
    to: to.map((address) => ({ address })),
    cc: cc.map((address) => ({ address })),
    flags: [],
    hasAttachments: false,
    attachmentCount: 0,
    attachments: [],
    bodyCached: false,
  };
}

describe("mail identities", () => {
  it("lists the account identity first, then aliases", () => {
    const identities = mailIdentities(info);
    expect(identities.map((identity) => identity.email)).toEqual(["me@example.com", "support@example.com"]);
    expect(identityFromHeader(identities[0])).toBeNull();
    expect(identityFromHeader(identities[1])).toBe("Support <support@example.com>");
    expect(ownIdentityAddresses(identities)).toEqual(["me@example.com", "support@example.com"]);
  });

  it("replies from the identity the message was sent to (AC-29)", () => {
    const identities = mailIdentities(info);
    expect(pickReplyIdentity(identities, header(["other@example.com"], ["SUPPORT@example.com"])).id).toBe("alias");
    expect(pickReplyIdentity(identities, header(["other@example.com"])).id).toBe("default");
  });

  it("parses identities from session options and drops invalid rows", () => {
    expect(parseMailIdentities('[{"email":"a@x.com","name":"A"},{"email":"broken"},7]')).toEqual([
      { id: "identity-1", name: "A", email: "a@x.com", replyTo: null, signature: null },
    ]);
    expect(parseMailIdentities("not json")).toEqual([]);
  });

  it("swaps only an unedited signature block", () => {
    expect(swapSignature("<p>hi</p><sig-a>", "<sig-a>", "<sig-b>")).toBe("<p>hi</p><sig-b>");
    expect(swapSignature("<p>hi</p><edited>", "<sig-a>", "<sig-b>")).toBe("<p>hi</p><edited>");
  });
});
