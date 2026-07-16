import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MailHtmlReader } from "./MailHtmlReader";

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
});
