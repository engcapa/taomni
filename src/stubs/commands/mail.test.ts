import { describe, expect, it } from "vitest";
import type { MailMessageBody, MailMessageHeader } from "../../lib/mail";
import { invokeMail } from "./mail";

describe("browser mail Sent copy", () => {
  it("returns the complete composed body after synchronizing the Sent folder", async () => {
    const accountId = "browser-sent-copy";
    const subject = "Sent copy body";
    const textBody = `${"long text ".repeat(25)}Last line of the message`;
    const htmlBody = "<p>HTML version of the message</p>";

    await invokeMail("mail_send_message", {
      config: { sessionId: accountId },
      request: { to: ["qa@example.test"], subject, textBody, htmlBody },
    });
    await invokeMail("mail_sync_folder", {
      config: { sessionId: accountId },
      folder: "Sent",
    });
    const headers = await invokeMail<MailMessageHeader[]>("mail_list_cached_messages", {
      accountId,
      folder: "Sent",
    });
    const header = headers.find((message) => message.subject === subject);
    expect(header).toBeDefined();
    const body = await invokeMail<MailMessageBody>("mail_get_message_body", {
      config: { sessionId: accountId },
      folder: "Sent",
      uid: header?.uid,
    });
    expect(body).toMatchObject({ subject, text: textBody, html: htmlBody });
  });
});
