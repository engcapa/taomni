import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lspCompletionResolve,
  type LspCompletionItem,
  type LspDocumentDescriptor,
} from "./lsp";

const coreMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => coreMocks);

const descriptor: LspDocumentDescriptor = {
  workspaceId: "ws-parity005",
  filePath: "/ws/Main.java",
  rootPath: "/ws",
  languageId: "java",
  documentUri: "file:///ws/Main.java",
};

const resolvedItem: LspCompletionItem = {
  label: "StringUtils",
  kind: 7,
  detail: "org.apache.commons.lang3.StringUtils",
  documentation: null,
  insertText: null,
  insertTextFormat: 1,
  filterText: null,
  sortText: null,
  textEdit: null,
  additionalTextEdits: [],
  raw: { label: "StringUtils" },
};

describe("ED-PARITY-005 completion resolve IPC", () => {
  beforeEach(() => {
    coreMocks.invoke.mockReset();
  });

  it("preserves resolved unavailable timeout failed across IPC", async () => {
    // A real resolve keeps the typed item.
    coreMocks.invoke.mockResolvedValueOnce({ kind: "resolved", item: resolvedItem });
    const resolved = await lspCompletionResolve(descriptor, { label: "StringUtils" });
    expect(resolved).toEqual({ kind: "resolved", item: resolvedItem });

    // Provider null / no session / unparsable payload: unavailable, never a
    // silent success on the original item.
    coreMocks.invoke.mockResolvedValueOnce({ kind: "unavailable", reason: "provider-returned-null" });
    const unavailable = await lspCompletionResolve(descriptor, { label: "StringUtils" });
    expect(unavailable).toEqual({ kind: "unavailable", reason: "provider-returned-null" });

    coreMocks.invoke.mockResolvedValueOnce({ kind: "unavailable", reason: "no-active-session" });
    expect(await lspCompletionResolve(descriptor, { label: "StringUtils" }))
      .toEqual({ kind: "unavailable", reason: "no-active-session" });

    coreMocks.invoke.mockResolvedValueOnce({ kind: "unavailable", reason: "resolve-not-advertised" });
    expect(await lspCompletionResolve(descriptor, { label: "StringUtils" }))
      .toEqual({ kind: "unavailable", reason: "resolve-not-advertised" });

    // Provider timeout stays a timeout.
    coreMocks.invoke.mockResolvedValueOnce({ kind: "timeout" });
    expect(await lspCompletionResolve(descriptor, { label: "StringUtils" }))
      .toEqual({ kind: "timeout" });

    // Transport/protocol error keeps its message.
    coreMocks.invoke.mockResolvedValueOnce({ kind: "failed", message: "connection reset" });
    expect(await lspCompletionResolve(descriptor, { label: "StringUtils" }))
      .toEqual({ kind: "failed", message: "connection reset" });

    // The command name and document identity are unchanged.
    expect(coreMocks.invoke).toHaveBeenLastCalledWith("lsp_completion_resolve", expect.objectContaining({
      workspaceId: "ws-parity005",
      filePath: "/ws/Main.java",
      item: { label: "StringUtils" },
    }));
    expect(coreMocks.invoke).toHaveBeenCalledTimes(6);
  });
});
