import { describe, expect, it } from "vitest";
import { mentionsAttachment, ownMessageText } from "./mailAttachReminder";

describe("mentionsAttachment", () => {
  it("detects attachment wording in English and Chinese", () => {
    expect(mentionsAttachment("", "Please find the report attached.", "")).toBe(true);
    expect(mentionsAttachment("", "", "<p>详见附件</p>")).toBe(true);
    expect(mentionsAttachment("Attachment: Q3 plan", "", "")).toBe(true);
    expect(mentionsAttachment("Lunch?", "See you at noon", "")).toBe(false);
  });

  it("ignores quoted text from the original message", () => {
    expect(mentionsAttachment("Re: plan", "Thanks!\n> I attached the plan", "")).toBe(false);
    expect(mentionsAttachment("Re: plan", "", "<p>Thanks!</p><blockquote><p>see attached</p></blockquote>")).toBe(false);
    expect(ownMessageText("", "<p>a</p><blockquote>b</blockquote>")).toBe("a");
  });
});
