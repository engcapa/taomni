import { describe, expect, it } from "vitest";
import { parseMailto } from "./mailto";

describe("parseMailto", () => {
  it("parses recipients and header fields", () => {
    expect(parseMailto("mailto:a@example.com,b@example.com?cc=c%40example.com&subject=Hello%20there&body=Line%201%0ALine%202")).toEqual({
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      bcc: [],
      subject: "Hello there",
      body: "Line 1\nLine 2",
    });
  });

  it("accepts list-unsubscribe style links and extra to= fields", () => {
    expect(parseMailto("MAILTO:leave@lists.example.com?subject=unsubscribe&to=also@example.com")).toMatchObject({
      to: ["leave@lists.example.com", "also@example.com"],
      subject: "unsubscribe",
    });
  });

  it("rejects non-mailto links", () => {
    expect(parseMailto("https://example.com")).toBeNull();
  });
});
