import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MailHtmlReader } from "./MailHtmlReader";

afterEach(() => {
  cleanup();
});

describe("MailHtmlReader", () => {
  it("renders a sandboxed iframe document with email styles applied", async () => {
    render(
      <MailHtmlReader
        html={`
          <html>
            <head><style>.banner { color: #0b57d0; font-weight: bold; }</style></head>
            <body><div class="banner">Welcome aboard</div></body>
          </html>
        `}
        allowRemoteImages={false}
        fontSize={15}
        preferDark={false}
      />,
    );

    const frame = await screen.findByTestId("mail-reader-html");
    expect(frame.tagName).toBe("IFRAME");
    const srcDoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("Welcome aboard");
    expect(srcDoc).toContain(".banner{");
    expect(srcDoc).toContain("color: #0b57d0");
    expect(srcDoc).toContain("Content-Security-Policy");
    expect(frame.getAttribute("sandbox")).toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");

    await waitFor(() => {
      expect(Number.parseInt(frame.style.height || "0", 10)).toBeGreaterThanOrEqual(120);
    });
  });

  // Regression: a frame document that can scroll on its own captures Chromium's
  // middle-click autoscroll, so the reading pane (outside the frame) stops
  // scrolling over the message body.
  it("locks the iframe document against its own scrolling so the pane keeps middle-click autoscroll", async () => {
    render(<MailHtmlReader html="<p>Body</p>" allowRemoteImages={false} />);

    const frame = await screen.findByTestId("mail-reader-html");
    const srcDoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain("html, body { margin: 0; padding: 0; overflow: hidden !important; }");
  });
});
