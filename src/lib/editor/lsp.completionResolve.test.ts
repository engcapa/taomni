import { beforeEach, describe, expect, it, vi } from "vitest";
import { lspCompletionResolve, type LspDocumentDescriptor } from "./lsp";

const coreMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => coreMocks);

const descriptor: LspDocumentDescriptor = {
  workspaceId: "parity005",
  filePath: "Main.java",
};

describe("ED-PARITY-005 completion resolve IPC", () => {
  beforeEach(() => coreMocks.invoke.mockReset());

  it.each([
    [{ kind: "unavailable", reason: "no-active-session" }, "unavailable"],
    [{ kind: "timeout" }, "timeout"],
    [{ kind: "failed", message: "provider rejected resolve" }, "failed"],
  ] as const)("preserves %s as %s", async (wire, kind) => {
    coreMocks.invoke.mockResolvedValueOnce(wire);
    const result = await lspCompletionResolve(descriptor, { label: "StringUtils" });
    expect(result.kind).toBe(kind);
    expect(coreMocks.invoke).toHaveBeenCalledWith("lsp_completion_resolve", expect.objectContaining({
      workspaceId: "parity005",
      item: { label: "StringUtils" },
    }));
  });

  it("preserves an actual resolved item", async () => {
    const item = { label: "StringUtils", additionalTextEdits: [{ newText: "import StringUtils;\n" }] };
    coreMocks.invoke.mockResolvedValueOnce({ kind: "resolved", item });
    expect(await lspCompletionResolve(descriptor, item)).toEqual({ kind: "resolved", item });
  });

  it("classifies an IPC transport rejection as failed", async () => {
    coreMocks.invoke.mockRejectedValueOnce(new Error("connection closed"));
    expect(await lspCompletionResolve(descriptor, { label: "StringUtils" })).toEqual({
      kind: "failed",
      message: "connection closed",
    });
  });
});
