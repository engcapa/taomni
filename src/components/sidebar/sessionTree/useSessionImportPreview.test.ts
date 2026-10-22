import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTaomniSessions, type SessionImportResult } from "../../../lib/sessionImportExport";
import { useSessionImportPreview } from "./useSessionImportPreview";

const prepare = vi.hoisted(() => vi.fn(async (result: SessionImportResult) => result));
vi.mock("../../../lib/sessionImportSecrets", () => ({ prepareImportedSecretsForSave: prepare }));

function fixture(): SessionImportResult {
  const parsed = parseTaomniSessions(JSON.stringify({ version: 1, sessions: [
    { name: "Alpha", type: "SSH", host: "alpha.test", port: 22 },
    { name: "Beta", type: "SSH", host: "beta.test", port: 22 },
  ] }));
  return { ...parsed, secrets: [
    { sessionId: parsed.sessions[0].id, kind: "password", label: "alpha", value: "fixture-alpha" },
    { sessionId: parsed.sessions[1].id, kind: "password", label: "beta", value: "fixture-beta" },
    { sessionId: "", attachment: "standalone", kind: "key-passphrase", label: "key", value: "fixture-key" },
  ] };
}

function setup() {
  const context = {
    enrichTabbyResult: vi.fn(async (result: SessionImportResult) => result),
    enrichSecureCrtResult: vi.fn(async (result: SessionImportResult) => result),
    importSessions: vi.fn(async () => {}),
    expandPath: vi.fn(),
    t: (key: string) => key,
    setStatusMessage: vi.fn(),
    reportWarnings: vi.fn(),
  };
  return { ...renderHook(() => useSessionImportPreview(context)), context };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("session import preview workflow", () => {
  it("saves only selected sessions and their secrets while retaining standalone secrets", async () => {
    const { result, context } = setup();
    const imported = fixture();
    act(() => result.current.queueImportPreview(imported, "Production", "Taomni"));
    expect(prepare).not.toHaveBeenCalled();
    await act(() => result.current.confirmPendingImport(new Set([imported.sessions[1].id])));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      sessions: [imported.sessions[1]], secrets: imported.secrets.slice(1), skipped: imported.skipped + 1,
    }), context.t);
    expect(context.importSessions).toHaveBeenCalledWith([imported.sessions[1]]);
    expect(context.expandPath).toHaveBeenCalledWith("Production");
    expect(result.current.pendingImport).toBeNull();
  });

  it("keeps a failed save available for retry and clears it only after success", async () => {
    const { result, context } = setup();
    const imported = fixture();
    act(() => result.current.queueImportPreview(imported, null, "Taomni"));
    context.importSessions.mockRejectedValueOnce(new Error("disk unavailable"));
    await act(async () => {
      await expect(result.current.confirmPendingImport(new Set(imported.sessions.map(s => s.id))))
        .rejects.toThrow("disk unavailable");
    });
    expect(result.current.pendingImport?.result).toBe(imported);
    expect(context.expandPath).not.toHaveBeenCalled();
    await act(() => result.current.confirmPendingImport(new Set(imported.sessions.map(s => s.id))));
    expect(result.current.pendingImport).toBeNull();
  });

  it("waits for external-secret enrichment before preview and cancellation saves nothing", async () => {
    const { result, context } = setup();
    const imported = { ...fixture(), externalSecretsTool: "tabby" as const };
    let complete!: (value: SessionImportResult) => void;
    context.enrichTabbyResult.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    act(() => result.current.queueImportPreview(imported, null, "Tabby"));
    expect(result.current.pendingImport).toBeNull();
    const enriched = { ...imported, warnings: ["keychain item unavailable"] };
    await act(async () => complete(enriched));
    expect(result.current.pendingImport?.result).toBe(enriched);
    act(() => result.current.setPendingImport(null));
    await act(() => result.current.confirmPendingImport(new Set()));
    expect(prepare).not.toHaveBeenCalled();
    expect(context.importSessions).not.toHaveBeenCalled();
  });
});
