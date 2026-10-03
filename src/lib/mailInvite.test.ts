import { describe, expect, it } from "vitest";
import type { MailInvite } from "./mail";
import { formatInviteRange, formatInviteTime, hasCalendarPart, inviteFileName, myPartstat } from "./mailInvite";

const invite: MailInvite = {
  method: "REQUEST",
  uid: "u1",
  sequence: 0,
  summary: "Review: Q3/Q4",
  start: { local: "2026-10-05T10:00", tzid: "China Standard Time", allDay: false },
  end: { local: "2026-10-05T11:00", tzid: "China Standard Time", allDay: false },
  organizer: { email: "boss@example.com", partstat: "NEEDS-ACTION" },
  attendees: [{ email: "Me@Example.com", partstat: "TENTATIVE" }],
  ics: "",
};

describe("mailInvite", () => {
  it("detects calendar parts", () => {
    expect(hasCalendarPart([{ contentType: "text/calendar" }])).toBe(true);
    expect(hasCalendarPart([{ name: "invite.ICS", contentType: "application/octet-stream" }])).toBe(true);
    expect(hasCalendarPart([{ contentType: "image/png" }])).toBe(false);
    expect(hasCalendarPart(undefined)).toBe(false);
  });

  it("formats zoned, UTC and all-day times", () => {
    expect(formatInviteTime(invite.start)).toBe("2026-10-05 10:00 (China Standard Time)");
    expect(formatInviteRange(invite)).toBe("2026-10-05 10:00 – 11:00 (China Standard Time)");
    expect(formatInviteTime({ local: "2026-10-05T02:00", epoch: 1_791_165_600, tzid: "UTC", allDay: false }, "en-US"))
      .toContain("2026");
    expect(formatInviteTime({ local: "2026-10-05", allDay: true }, "en-US")).toContain("Oct");
    expect(formatInviteTime(null)).toBe("");
  });

  it("finds my response and an export name", () => {
    expect(myPartstat(invite, "me@example.com")).toBe("TENTATIVE");
    expect(myPartstat(invite, "other@example.com")).toBeNull();
    expect(inviteFileName(invite)).toBe("Review  Q3 Q4.ics");
  });
});
