import { describe, expect, it } from "vitest";
import {
  externalPreviewHref, htmlFileAddress, localPreviewHref, previewRoot, previewRoute,
  previewRouteUrl, pushHtmlHistory, readHtmlBridgeMessage, validatePreviewSession,
} from "./HtmlPreviewBridge";

const session = { token: "abc-123", url: "taomni-preview://localhost/abc-123/report.html" };

describe("HTML preview token-bound local navigation", () => {
  it.each([
    session,
    { token: "abc-123", url: "http://taomni-preview.localhost/abc-123/report.html" },
    { token: "abc-123", url: "http://127.0.0.1:54321/abc-123/report.html" },
  ])("handles native protocol platforms %s", (value) => {
    const href = localPreviewHref("assets/second%20page.html?q=1#title", value);
    expect(href).toContain("/abc-123/assets/second%20page.html?q=1#title");
    expect(previewRoute(href!, value)).toBe("assets/second%20page.html?q=1#title");
    expect(previewRouteUrl("assets/second%20page.html?q=1#title", value)).toBe(href);
    expect(localPreviewHref("../other.html", value)).toBeNull();
    expect(localPreviewHref("/different-token/secret.html", value)).toBeNull();
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "https://example.invalid/", "tauri://localhost/secret", "//other/path", "%252e%252e/secret", "assets/%2Fetc", "assets/%255csecret", "assets/%00", "assets/%E0%A4%A"])("rejects unsafe route %s", (href) => {
    expect(localPreviewHref(href, session)).toBeNull();
  });

  it("keeps same-root child-to-parent navigation and Unicode/percent filenames valid", () => {
    expect(localPreviewHref("../report.html", session, "taomni-preview://localhost/abc-123/sub/page.html")).toBe(session.url);
    expect(localPreviewHref("50%25.html", session)).toContain("50%25.html");
    expect(localPreviewHref("%E4%B8%AD%E6%96%87.html", session)).toContain("%E4%B8%AD%E6%96%87.html");
  });

  it.each([
    { token: "abc-123", url: "https://arbitrary.invalid/abc-123/report.html" },
    { token: "abc-123", url: "taomni-preview://localhost/other/report.html" },
    { token: "../bad", url: "taomni-preview://localhost/bad/report.html" },
    { token: "abc-123", url: "http://taomni-preview.localhost:9000/abc-123/report.html" },
    { token: "abc-123", url: "https://127.0.0.1:9000/abc-123/report.html" },
    { token: "abc-123", url: "http://127.0.0.1/abc-123/report.html" },
  ])("rejects invalid session root %s", (value) => expect(() => previewRoot(value)).toThrow());
});

describe("browser-only blob simulation", () => {
  const blob = { token: "stub-123", url: "blob:http://localhost:5000/registered" };
  it("accepts only the returned blob document and hash navigation in a browser", () => {
    expect(() => validatePreviewSession(blob)).not.toThrow();
    expect(localPreviewHref("#section", blob)).toBe(blob.url + "#section");
    expect(localPreviewHref("blob:http://localhost:5000/unrelated", blob)).toBeNull();
    expect(previewRoute(blob.url, blob)).toBe("");
    expect(previewRouteUrl("#section", blob)).toBe(blob.url + "#section");
    expect(previewRouteUrl("other.html", blob)).toBeNull();
  });
  it("never admits blob simulation into a native webview", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    try { expect(() => validatePreviewSession(blob)).toThrow("Invalid HTML preview protocol"); }
    finally { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; }
  });
});

describe("opaque sandbox bridge authentication", () => {
  const frame = {} as Window;
  const data = { type: "taomni-html-preview", token: session.token, kind: "console", level: "warn", message: "fixture ready" };
  const event = (source: Window, payload: unknown) => ({ source, data: payload } as MessageEvent);

  it("requires both iframe source and token, not origin='null' alone", () => {
    expect(readHtmlBridgeMessage(event(frame, data), frame, session)?.message).toBe("fixture ready");
    expect(readHtmlBridgeMessage(event({} as Window, data), frame, session)).toBeNull();
    expect(readHtmlBridgeMessage(event(frame, { ...data, token: "stale-token" }), frame, session)).toBeNull();
    expect(readHtmlBridgeMessage(event(frame, { ...data, type: "other" }), frame, session)).toBeNull();
    expect(readHtmlBridgeMessage(event(frame, data), null, session)).toBeNull();
  });

  it("validates shape, bounds text, and maps unrecognized levels to log", () => {
    expect(readHtmlBridgeMessage(event(frame, { ...data, message: 4 }), frame, session)).toBeNull();
    expect(readHtmlBridgeMessage(event(frame, { ...data, href: "x".repeat(20000) }), frame, session)).toBeNull();
    const message = readHtmlBridgeMessage(event(frame, { ...data, level: "bogus", message: "x".repeat(10000) }), frame, session);
    expect(message?.level).toBe("log");
    expect(message?.message).toHaveLength(8192);
  });

  it.each(["file:///secret", "javascript:alert(1)", "tauri://localhost", "asset://localhost/secret", "https://user:password@example.invalid", "http://taomni-preview.localhost/other", "http://ipc.localhost/invoke", "http://asset.localhost/secret", "http://localhost/private", "http://localhost./private", "http://tauri.localhost./invoke", "http://127.0.0.1/private", "http://127.1/private", "http://[::1]/private", "http://[::ffff:127.0.0.1]/private"]) ("blocks non-public external href %s", (href) => expect(externalPreviewHref(href)).toBeNull());
  it("allows only ordinary HTTP(S) external navigation", () => expect(externalPreviewHref("https://example.invalid/docs")).toBe("https://example.invalid/docs"));
});

describe("local address and navigation history", () => {
  it("displays local file paths without exposing protocol tokens", () => {
    expect(htmlFileAddress("/docs/report.html")).toBe("file:///docs/report.html");
    expect(htmlFileAddress("\\\\server\\share\\report.html")).toBe("file://server/share/report.html");
    expect(htmlFileAddress("C:\\docs\\report.html", "child/page%20two.html", "report.html")).toBe("file:///C:/docs/child/page two.html");
  });

  it("truncates forward history on new navigation and avoids duplicates", () => {
    const first = { entries: ["report.html"], index: 0 };
    const next = pushHtmlHistory(first, "two.html");
    expect(next).toEqual({ entries: ["report.html", "two.html"], index: 1 });
    expect(pushHtmlHistory(next, "two.html")).toBe(next);
    expect(pushHtmlHistory({ ...next, index: 0 }, "three.html")).toEqual({ entries: ["report.html", "three.html"], index: 1 });
  });
});
