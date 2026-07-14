import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitBlobPair } from "../../lib/git";
import { DiffViewer } from "./DiffViewer";

function pair(oldText: string, newText: string): GitBlobPair {
  return {
    path: "src/a.ts",
    oldPath: null,
    oldText,
    newText,
    oldExists: true,
    newExists: true,
    binary: false,
    image: false,
    oldImageB64: null,
    newImageB64: null,
    oversize: false,
    oldSize: oldText.length,
    newSize: newText.length,
  };
}

describe("DiffViewer EOL-only banner (issue #324 B2)", () => {
  afterEach(() => cleanup());

  it("shows a banner and normalize action for LF vs CRLF-only pairs", () => {
    const onNormalize = vi.fn();
    render(
      <DiffViewer
        pair={pair("hello\nworld\n", "hello\r\nworld\r\n")}
        onNormalizeLineEndings={onNormalize}
      />,
    );

    expect(screen.getByTestId("git-diff-eol-only-banner")).toHaveTextContent(/Line endings only/i);
    expect(screen.getByTestId("git-diff-eol-only-banner")).toHaveTextContent("LF");
    expect(screen.getByTestId("git-diff-eol-only-banner")).toHaveTextContent("CRLF");
    fireEvent.click(screen.getByTestId("git-diff-normalize-eol"));
    expect(onNormalize).toHaveBeenCalledTimes(1);
  });

  it("does not show the banner when content actually differs", () => {
    render(<DiffViewer pair={pair("hello\n", "hallo\n")} />);
    expect(screen.queryByTestId("git-diff-eol-only-banner")).not.toBeInTheDocument();
  });
});
