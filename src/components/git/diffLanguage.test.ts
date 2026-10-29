import { describe, expect, it, vi } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { languageForPath } from "./diffLanguage";

const grammars = vi.hoisted(() => ({ json: vi.fn(() => []) }));
vi.mock("@codemirror/lang-json", () => ({ json: grammars.json }));

describe("shared editor languages", () => {
  it("shares grammar identity across files, aliases and simultaneous requests", async () => {
    const [first, second, third] = await Promise.all([languageForPath("a.json"), languageForPath("b.JSONC"), languageForPath("c.json")]);
    expect(first).toBe(second);
    expect(first).toBe(third);
    expect(grammars.json).toHaveBeenCalledTimes(1);
  });
  it("keeps TypeScript, TSX and JavaScript configuration distinct", async () => {
    const [ts, tsx, js, jsx] = await Promise.all([languageForPath("a.ts"), languageForPath("b.tsx"), languageForPath("c.js"), languageForPath("d.jsx")]);
    expect(ts).not.toBe(tsx);
    expect(tsx).not.toBe(js);
    expect(js).toBe(jsx);
    const parses = (language: Extension | null, doc: string) => {
      let error = false;
      syntaxTree(EditorState.create({ doc, extensions: language ?? [] })).iterate({ enter: (node) => { error ||= node.type.isError; } });
      return !error;
    };
    expect(parses(ts, "const value: number = 1;")).toBe(true);
    expect(parses(js, "const element = <div />;")).toBe(true);
    expect(parses(tsx, "const element = <div />;")).toBe(true);
    expect(parses(ts, "const element = <div />;")).toBe(false);
  });
  it("retries a failed grammar load instead of caching its rejection", async () => {
    grammars.json.mockImplementationOnce(() => { throw new Error("temporary import failure"); });
    vi.resetModules();
    const retry = (await import("./diffLanguage")).languageForPath;
    await expect(retry("failed.json")).rejects.toThrow("temporary import failure");
    await expect(retry("retry.json")).resolves.toEqual([]);
  });
  it("keeps unknown and missing extensions as plain text", async () => {
    await expect(languageForPath("a.txt")).resolves.toBeNull();
    await expect(languageForPath(undefined)).resolves.toBeNull();
  });
});
