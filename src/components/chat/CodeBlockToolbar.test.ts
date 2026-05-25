import { describe, expect, it } from "vitest";
import {
  isCommentLikeLine,
  isSelectableTerminalLine,
  prepareTerminalInput,
  splitFencedBlocks,
} from "./CodeBlockToolbar";

describe("splitFencedBlocks", () => {
  it("returns a single text segment when there are no fences", () => {
    const segs = splitFencedBlocks("Hello, world.");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ kind: "text", value: "Hello, world." });
  });

  it("extracts a single fenced block with language", () => {
    const segs = splitFencedBlocks("Run this:\n\n```bash\nls -la\n```\n");
    expect(segs).toHaveLength(3);
    expect(segs[0].kind).toBe("text");
    expect(segs[0].value).toMatch(/^Run this:/);
    expect(segs[1]).toEqual({ kind: "code", lang: "bash", value: "ls -la" });
    expect(segs[2].kind).toBe("text");
  });

  it("handles a block with no language hint", () => {
    const segs = splitFencedBlocks("```\nhello\n```");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({ kind: "code", lang: null, value: "hello" });
  });

  it("extracts multiple sequential blocks", () => {
    const md = "```sh\necho 1\n```\n\nthen\n\n```sh\necho 2\n```";
    const segs = splitFencedBlocks(md);
    const codeSegs = segs.filter((s) => s.kind === "code");
    expect(codeSegs).toHaveLength(2);
    expect(codeSegs[0].value).toBe("echo 1");
    expect(codeSegs[1].value).toBe("echo 2");
  });

  it("preserves multi-line block bodies", () => {
    const segs = splitFencedBlocks("```py\nprint('a')\nprint('b')\n```");
    const code = segs.find((s) => s.kind === "code");
    expect(code?.value).toBe("print('a')\nprint('b')");
  });
});

describe("code block terminal helpers", () => {
  it("classifies comment and blank lines as non-selectable", () => {
    expect(isCommentLikeLine("# comment", "bash")).toBe(true);
    expect(isCommentLikeLine("  // comment", "typescript")).toBe(true);
    expect(isCommentLikeLine("-- sql comment", "sql")).toBe(true);
    expect(isCommentLikeLine("--flag value", "bash")).toBe(false);

    expect(isSelectableTerminalLine("", "bash")).toBe(false);
    expect(isSelectableTerminalLine("  # comment", "bash")).toBe(false);
    expect(isSelectableTerminalLine("ss -tlnp", "bash")).toBe(true);
  });

  it("does not append enter for a single line terminal send", () => {
    expect(prepareTerminalInput("ss -tlnp")).toEqual({
      text: "ss -tlnp",
      isMultiline: false,
      lineCount: 1,
    });
  });

  it("marks multi-line terminal sends for confirmation and preserves line breaks", () => {
    expect(prepareTerminalInput("lsof -p 1234\nlsof -i :8080")).toEqual({
      text: "lsof -p 1234\rlsof -i :8080",
      isMultiline: true,
      lineCount: 2,
    });
  });
});
