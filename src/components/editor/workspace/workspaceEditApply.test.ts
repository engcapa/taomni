import { describe, expect, it, vi } from "vitest";
import {
  applyWorkspaceEdit,
  summarizeWorkspaceEditOutcomes,
} from "./workspaceEditApply";
import type { LspWorkspaceEdit } from "../../../lib/editor/lsp";

function edit(uri: string, path: string, newText: string): LspWorkspaceEdit {
  return {
    documentEdits: [{
      uri,
      path,
      edits: [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        newText,
      }],
    }],
  };
}

describe("applyWorkspaceEdit", () => {
  it("applies edits to open dirty buffers without writing disk", async () => {
    const applyToOpenBuffer = vi.fn();
    const writeDisk = vi.fn();
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/a.ts", "/repo/a.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x = 1", dirty: true, key: "k1" }),
        applyToOpenBuffer,
        readDisk: async () => null,
        writeDisk,
      },
    );
    expect(applyToOpenBuffer).toHaveBeenCalledWith("k1", "Z = 1");
    expect(writeDisk).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "applied-open", dirty: true });
  });

  it("writes unopened files via disk hooks with hash", async () => {
    const writeDisk = vi.fn(async () => {});
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/b.ts", "/repo/b.ts", "Y"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => null,
        applyToOpenBuffer: () => {},
        readDisk: async () => ({ text: "x", hash: "h1" }),
        writeDisk,
      },
    );
    expect(writeDisk).toHaveBeenCalledWith("/repo/b.ts", "Y", "h1");
    expect(outcomes[0]).toMatchObject({ status: "applied-disk" });
  });

  it("records failures without rolling back prior successes", async () => {
    const outcomes = await applyWorkspaceEdit(
      {
        documentEdits: [
          {
            uri: "file:///repo/ok.ts",
            path: "/repo/ok.ts",
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "A",
            }],
          },
          {
            uri: "file:///repo/bad.ts",
            path: "/repo/bad.ts",
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: "B",
            }],
          },
        ],
      },
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: (path) => path.endsWith("ok.ts")
          ? { text: "x", dirty: false, key: "ok" }
          : null,
        applyToOpenBuffer: () => {},
        readDisk: async (path) => {
          if (path.endsWith("bad.ts")) throw new Error("hash mismatch");
          return { text: "x", hash: "h" };
        },
        writeDisk: async () => {},
      },
    );
    expect(outcomes[0].status).toBe("applied-open");
    expect(outcomes[1]).toMatchObject({ status: "failed", reason: "hash mismatch" });
    expect(summarizeWorkspaceEditOutcomes(outcomes)).toContain("Applied 1");
  });
});
