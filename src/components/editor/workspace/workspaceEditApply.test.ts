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
  it("applies edits to open dirty buffers without saving or writing disk", async () => {
    const applyToOpenBuffer = vi.fn();
    const saveOpenBuffer = vi.fn(async () => {});
    const writeDisk = vi.fn();
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/a.ts", "/repo/a.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x = 1", dirty: true, key: "k1" }),
        applyToOpenBuffer,
        saveOpenBuffer,
        readDisk: async () => null,
        writeDisk,
      },
    );
    expect(applyToOpenBuffer).toHaveBeenCalledWith("k1", "Z = 1");
    expect(saveOpenBuffer).not.toHaveBeenCalled();
    expect(writeDisk).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "applied-open", dirty: true });
  });

  it("applies edits to open clean buffers then saves so the buffer stays clean", async () => {
    const applyToOpenBuffer = vi.fn();
    const saveOpenBuffer = vi.fn(async () => {});
    const writeDisk = vi.fn();
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/clean.ts", "/repo/clean.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x = 1", dirty: false, key: "clean-key" }),
        applyToOpenBuffer,
        saveOpenBuffer,
        readDisk: async () => null,
        writeDisk,
      },
    );
    expect(applyToOpenBuffer).toHaveBeenCalledWith("clean-key", "Z = 1");
    expect(saveOpenBuffer).toHaveBeenCalledWith("clean-key", "Z = 1");
    expect(writeDisk).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "applied-open", dirty: false });
  });

  it("writes unopened files via disk hooks with hash", async () => {
    const writeDisk = vi.fn(async () => {});
    const saveOpenBuffer = vi.fn(async () => {});
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/b.ts", "/repo/b.ts", "Y"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => null,
        applyToOpenBuffer: () => {},
        saveOpenBuffer,
        readDisk: async () => ({ text: "x", hash: "h1" }),
        writeDisk,
      },
    );
    expect(writeDisk).toHaveBeenCalledWith("/repo/b.ts", "Y", "h1");
    expect(saveOpenBuffer).not.toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "applied-disk" });
  });

  it("records failures without rolling back prior successes", async () => {
    const saveOpenBuffer = vi.fn(async () => {});
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
        saveOpenBuffer,
        readDisk: async (path) => {
          if (path.endsWith("bad.ts")) throw new Error("hash mismatch");
          return { text: "x", hash: "h" };
        },
        writeDisk: async () => {},
      },
    );
    // Open-clean path applied and saved.
    expect(saveOpenBuffer).toHaveBeenCalledWith("ok", "A");
    expect(outcomes[0]).toMatchObject({ status: "applied-open", dirty: false });
    expect(outcomes[1]).toMatchObject({ status: "failed", reason: "hash mismatch" });
    expect(summarizeWorkspaceEditOutcomes(outcomes)).toContain("Applied 1");
  });

  it("marks open-clean apply as failed when saveOpenBuffer throws", async () => {
    const applyToOpenBuffer = vi.fn();
    const saveOpenBuffer = vi.fn(async () => {
      throw new Error("disk full");
    });
    const outcomes = await applyWorkspaceEdit(
      edit("file:///repo/c.ts", "/repo/c.ts", "Z"),
      {
        resolvePath: (file) => file.path,
        getOpenBuffer: () => ({ text: "x", dirty: false, key: "c" }),
        applyToOpenBuffer,
        saveOpenBuffer,
        readDisk: async () => null,
        writeDisk: async () => {},
      },
    );
    expect(applyToOpenBuffer).toHaveBeenCalled();
    expect(saveOpenBuffer).toHaveBeenCalled();
    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "disk full" });
  });
});
