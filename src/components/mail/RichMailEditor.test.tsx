import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichMailEditor } from "./RichMailEditor";

describe("RichMailEditor", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the Thunderbird-style compose toolbar and editable body", () => {
    render(
      <RichMailEditor
        html="<p>Hello <strong>team</strong></p>"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("mail-compose-format-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-format-block")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-font-family")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-font-size")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-text-color")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-bold")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-bullet-list")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-link")).toBeInTheDocument();
    expect(screen.getByTestId("mail-compose-editor")).toHaveTextContent("Hello team");
  });

  it("emits sanitized HTML and plain text when the contenteditable body changes", () => {
    const onChange = vi.fn();
    render(<RichMailEditor html="<p><br></p>" onChange={onChange} />);

    const editor = screen.getByTestId("mail-compose-editor");
    editor.innerHTML = "<p>Hello<br>World</p>";
    fireEvent.input(editor);

    expect(onChange).toHaveBeenLastCalledWith("<p>Hello<br>World</p>", "Hello\nWorld");
  });

  it("executes toolbar commands and marks the draft as rich text", () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const onChange = vi.fn();
    const onRichFormatUsed = vi.fn();

    render(
      <RichMailEditor
        html="<p>Hello</p>"
        onChange={onChange}
        onRichFormatUsed={onRichFormatUsed}
      />,
    );

    fireEvent.click(screen.getByTestId("mail-compose-bold"));

    expect(execCommand).toHaveBeenCalledWith("bold", false, undefined);
    expect(onRichFormatUsed).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("<p>Hello</p>", "Hello");
  });
});
