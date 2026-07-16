import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MailMessageBodyView } from "./MailMessageBodyView";

describe("MailMessageBodyView", () => {
  afterEach(() => {
    cleanup();
  });

  it("defaults to HTML and can switch to plain when both parts exist", () => {
    render(
      <MailMessageBodyView
        html="<p>HTML body</p>"
        text={"> quoted plain\nhttps://example.com"}
        allowRemoteImages={false}
        preferDark={false}
        fontSize={14}
        title="Mixed"
      />,
    );

    expect(screen.getByTestId("mail-body-mode-toggle")).toBeInTheDocument();
    const frame = screen.getByTestId("mail-reader-html");
    expect(frame.getAttribute("srcdoc") ?? "").toContain("HTML body");

    fireEvent.click(screen.getByTestId("mail-body-mode-plain"));
    expect(screen.getByTestId("mail-reader-text")).toBeInTheDocument();
    expect(screen.getByText("quoted plain")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://example.com" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
  });

  it("renders plain-only with dark paper when preferDark", () => {
    const plain = ["> one", ">> two"].join("\n");
    render(
      <MailMessageBodyView
        text={plain}
        allowRemoteImages={false}
        preferDark
        fontSize={15}
      />,
    );

    expect(screen.queryByTestId("mail-body-mode-toggle")).not.toBeInTheDocument();
    const paper = screen.getByTestId("mail-reader-paper");
    expect(paper).toHaveAttribute("data-reader-theme", "dark");
    expect(paper.className).toContain("is-dark");
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
  });
});
