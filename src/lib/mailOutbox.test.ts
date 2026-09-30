import { describe, expect, it } from "vitest";
import type { MailDraft } from "./mail";
import {
  fromDateTimeLocal,
  isOutbox,
  isTransientSendError,
  outboxDue,
  outboxNextAttemptAt,
  toDateTimeLocal,
} from "./mailOutbox";

function draft(outbox: unknown): MailDraft {
  return {
    id: "d1",
    accountId: "a",
    to: ["x@example.com"],
    cc: [],
    bcc: [],
    subject: "s",
    textBody: "t",
    htmlBody: "",
    attachments: [],
    replyContext: outbox == null ? null : { outbox: outbox as never },
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("mailOutbox", () => {
  it("recognizes queued drafts", () => {
    expect(isOutbox(draft(null))).toBe(false);
    expect(isOutbox(draft({ queuedAt: 1, attempts: 0 }))).toBe(true);
  });

  it("schedules send-later and backs off after failures", () => {
    expect(outboxNextAttemptAt({ queuedAt: 100, attempts: 0 })).toBeNull();
    expect(outboxNextAttemptAt({ queuedAt: 100, attempts: 0, sendAt: 500 })).toBe(500);
    expect(outboxNextAttemptAt({ queuedAt: 100, attempts: 1, sendAt: 100 })).toBe(160);
    expect(outboxNextAttemptAt({ queuedAt: 100, attempts: 2, sendAt: 100 })).toBe(280);
    expect(outboxDue(draft({ queuedAt: 100, attempts: 0, sendAt: 500 }), 499)).toBe(false);
    expect(outboxDue(draft({ queuedAt: 100, attempts: 0, sendAt: 500 }), 500)).toBe(true);
    expect(outboxDue(draft({ queuedAt: 100, attempts: 0 }), 10_000)).toBe(false);
  });

  it("classifies transient send failures", () => {
    expect(isTransientSendError("SMTP connect failed: Connection refused (os error 111)")).toBe(true);
    expect(isTransientSendError("failed to lookup address information")).toBe(true);
    expect(isTransientSendError("SMTP send failed: 421 service not available")).toBe(true);
    expect(isTransientSendError("SMTP authentication failed: 535 bad credentials")).toBe(false);
    expect(isTransientSendError("invalid recipient: nope")).toBe(false);
    expect(isTransientSendError("SMTP auth failed for smtp.example.com:465: 535")).toBe(false);
  });

  it("round-trips datetime-local values", () => {
    const at = fromDateTimeLocal("2030-01-02T03:04");
    expect(at).not.toBeNull();
    expect(toDateTimeLocal(at!)).toBe("2030-01-02T03:04");
    expect(fromDateTimeLocal("")).toBeNull();
  });
});
