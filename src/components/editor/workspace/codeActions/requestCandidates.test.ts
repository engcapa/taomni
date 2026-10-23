import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspCodeAction } from "../../../../lib/editor/lsp";
import { CanonicalCodeActionService } from "./service";
import type { CodeActionContextIdentity } from "./types";

const context: CodeActionContextIdentity = {
  document: { uri: "file:///workspace/QuickFixTarget.java", revision: 4, languageId: "java" },
  provider: { id: "jdtls", version: "1.50.0", generation: 2, projectFingerprint: "fixture", trusted: true },
  range: { start: { line: 12, character: 33 }, end: { line: 12, character: 33 } },
  diagnostics: [],
  only: ["quickfix"],
};
const cancelled = "Java code assist was cancelled by the language server: Internal error.";
const action: LspCodeAction = {
  title: "Import 'StringUtils' (org.apache.commons.lang3)", kind: "quickfix", isPreferred: true,
  edit: null, command: null, commandArguments: null, raw: { title: "Import 'StringUtils'" },
};
const service = new CanonicalCodeActionService();

afterEach(() => vi.useRealTimers());

describe("JDT LS candidate query cancellation recovery", () => {
  it("returns the real candidates after one internal code-assist cancellation without resolving or executing them", async () => {
    const client = {
      requestCodeActions: vi.fn().mockRejectedValueOnce(new Error(cancelled)).mockResolvedValueOnce([action]),
      resolveCodeAction: vi.fn(),
    };
    const result = await service.requestCandidates(context, client);
    expect(result.state).toBe("ready");
    if (result.state === "ready") expect(result.actions[0].action.title).toBe(action.title);
    expect(client.requestCodeActions).toHaveBeenCalledTimes(2);
    expect(client.requestCodeActions.mock.calls[1]).toEqual(client.requestCodeActions.mock.calls[0]);
    expect(client.resolveCodeAction).not.toHaveBeenCalled();
  });

  it("surfaces a repeated cancellation after two requests", async () => {
    const requestCodeActions = vi.fn().mockRejectedValue(new Error(cancelled));
    const result = await service.requestCandidates(context, { requestCodeActions });
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.message).toContain(cancelled);
    expect(requestCodeActions).toHaveBeenCalledTimes(2);
  });

  it.each([
    "Internal error.", "language server request cancelled: document changed",
    "language server request cancelled: document closed", "language server request timed out: textDocument/codeAction",
  ])("preserves the original result without replaying %s", async (message) => {
    const requestCodeActions = vi.fn().mockRejectedValue(new Error(message));
    const result = await service.requestCandidates(context, { requestCodeActions });
    expect(result.state).not.toBe("ready");
    expect(requestCodeActions).toHaveBeenCalledTimes(1);
  });

  it("does not infer recovery for another provider from a similar message", async () => {
    const requestCodeActions = vi.fn().mockRejectedValue(new Error(cancelled));
    const result = await service.requestCandidates({ ...context, provider: { ...context.provider, id: "typescript" } }, { requestCodeActions });
    expect(result.state).toBe("failed");
    expect(requestCodeActions).toHaveBeenCalledTimes(1);
  });

  it("does not send another query after the caller cancels the intention request", async () => {
    const abort = new AbortController();
    let reject!: (error: Error) => void;
    const requestCodeActions = vi.fn(() => new Promise<readonly LspCodeAction[]>((_, fail) => { reject = fail; }));
    const pending = service.requestCandidates(context, { requestCodeActions }, { signal: abort.signal });
    abort.abort();
    reject(new Error(cancelled));
    expect((await pending).state).toBe("cancelled");
    expect(requestCodeActions).toHaveBeenCalledTimes(1);
  });

  it("keeps both attempts inside the original timeout", async () => {
    vi.useFakeTimers();
    const requestCodeActions = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error(cancelled)), 700)))
      .mockImplementationOnce(() => new Promise(() => {}));
    const pending = service.requestCandidates(context, { requestCodeActions }, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(700);
    expect(requestCodeActions).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300);
    expect((await pending).state).toBe("timeout");
    expect(requestCodeActions.mock.calls[1][1].aborted).toBe(true);
  });

  it("does not restart a query whose cancellation response arrives after the deadline", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const requestCodeActions = vi.fn(() => new Promise<readonly LspCodeAction[]>((_, fail) => { reject = fail; }));
    const pending = service.requestCandidates(context, { requestCodeActions }, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).state).toBe("timeout");
    reject(new Error(cancelled));
    await vi.advanceTimersByTimeAsync(0);
    expect(requestCodeActions).toHaveBeenCalledTimes(1);
  });
});
