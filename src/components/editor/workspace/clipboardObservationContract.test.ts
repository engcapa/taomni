import { describe, expect, it } from "vitest";
import {
  assertClipboardObservationIsRedacted,
  createClipboardCancelledObservation,
  createClipboardReadObservation,
  createClipboardWriteObservation,
} from "./clipboardObservationContract";
import type {
  EditorClipboardSession,
  GuardedSystemReadResult,
  GuardedSystemWriteResult,
} from "./workspaceClipboardSession";

function session(overrides: Partial<EditorClipboardSession> = {}): EditorClipboardSession {
  return {
    sessionId: "clip-test-1",
    sourceViewId: "cm-a",
    segments: ["alpha", "beta"],
    rectangular: true,
    plainText: "alpha\nbeta",
    sourceEol: "lf",
    createdAt: 1_756_000_000_000,
    ...overrides,
  };
}

const base = {
  permission: "unknown" as const,
  permissionGeneration: 4,
  historyExclusion: "recorded" as const,
  payloadRevision: 7,
  caretCount: 2,
  observedAt: 1_756_000_000_123,
};

describe("clipboardObservationContract", () => {
  it("keeps a completed OS write performed even when ownership went stale", () => {
    const result: GuardedSystemWriteResult = {
      outcome: "stale-generation",
      baseGeneration: 4,
      currentGeneration: 5,
      systemEffect: "performed",
    };
    const record = createClipboardWriteObservation({
      ...base,
      operation: "copy",
      result,
      payload: { plainText: "alpha\nbeta", segments: ["alpha", "beta"], rectangular: true },
    });
    // ED-CLIP-002: ownership and effect are independent axes.
    expect(record.outcome).toBe("stale-generation");
    expect(record.systemEffect).toBe("performed");
    expect(record.baseGeneration).toBe(4);
    expect(record.segmentCount).toBe(2);
    expect(record.rectangular).toBe(true);
    expect(record.caretCount).toBe(2);
  });

  it("reports not-performed only for the pre-await denial", () => {
    const record = createClipboardWriteObservation({
      ...base,
      operation: "copy",
      result: { outcome: "denied", systemEffect: "not-performed" },
      payload: { plainText: "x", rectangular: false },
    });
    expect(record.outcome).toBe("denied");
    expect(record.systemEffect).toBe("not-performed");
    expect(record.segmentCount).toBeNull();
  });

  it("keeps performed for a denial discovered after the write completed", () => {
    const record = createClipboardWriteObservation({
      ...base,
      operation: "cut",
      result: { outcome: "denied", systemEffect: "performed" },
      payload: { plainText: "x", rectangular: false },
    });
    expect(record.operation).toBe("cut");
    expect(record.systemEffect).toBe("performed");
  });

  it("reports unknown effect and the visible workspace fallback on a failed OS read", () => {
    const result: GuardedSystemReadResult = {
      outcome: "unavailable",
      systemEffect: "unknown",
      fallbackSession: session(),
    };
    const record = createClipboardReadObservation({ ...base, operation: "paste", result });
    expect(record.outcome).toBe("unavailable");
    expect(record.systemEffect).toBe("unknown");
    expect(record.usedWorkspaceFallback).toBe(true);
    expect(record.segmentCount).toBe(2);
    expect(record.rectangular).toBe(true);
    expect(record.payloadLength).toBe("alpha\nbeta".length);
  });

  it("does not claim a fallback when the OS read failed and no slot existed", () => {
    const record = createClipboardReadObservation({
      ...base,
      operation: "paste",
      result: { outcome: "denied", systemEffect: "not-performed", fallbackSession: null },
    });
    expect(record.usedWorkspaceFallback).toBe(false);
    expect(record.payloadLength).toBeNull();
    expect(record.segmentCount).toBeNull();
  });

  it("does not claim a fallback on a successful OS read", () => {
    const record = createClipboardReadObservation({
      ...base,
      operation: "paste",
      result: { outcome: "success", text: "from-os", systemEffect: "performed" },
    });
    expect(record.usedWorkspaceFallback).toBe(false);
    expect(record.payloadLength).toBe("from-os".length);
    expect(record.rectangular).toBe(false);
  });

  it("never carries clipboard text in the projected record", () => {
    const record = createClipboardWriteObservation({
      ...base,
      operation: "copy",
      result: { outcome: "success", systemEffect: "performed" },
      payload: { plainText: "secret-token-value", segments: ["secret-token-value"], rectangular: false },
    });
    expect(JSON.stringify(record)).not.toContain("secret-token-value");
    expect(() => assertClipboardObservationIsRedacted(record)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ED-IMPROVE-009: a late clipboard result whose owner moved on is reported as
// cancelled while keeping the real OS effect fact.
// ---------------------------------------------------------------------------
describe("ED-IMPROVE-009 cancelled clipboard observations", () => {
  it("keeps a performed write fact on a cancelled cut", () => {
    const record = createClipboardCancelledObservation({
      operation: "cut",
      systemEffect: "performed",
      permission: "granted",
      permissionGeneration: 4,
      historyExclusion: "recorded",
      payloadRevision: 2,
      caretCount: 3,
      segmentCount: 2,
      rectangular: false,
      payloadLength: 6,
    });
    expect(record).toMatchObject({
      operation: "cut",
      outcome: "cancelled",
      systemEffect: "performed",
      caretCount: 3,
      segmentCount: 2,
      payloadLength: 6,
    });
    assertClipboardObservationIsRedacted(record);
  });

  it("keeps an unknown write fact on a cancelled cut and a cancelled read", () => {
    const write = createClipboardCancelledObservation({
      operation: "cut",
      systemEffect: "unknown",
      permission: "unknown",
      permissionGeneration: 0,
      historyExclusion: "recorded",
      payloadRevision: 0,
      caretCount: 1,
    });
    expect(write.systemEffect).toBe("unknown");
    expect(write.outcome).toBe("cancelled");

    const read = createClipboardCancelledObservation({
      operation: "paste",
      systemEffect: "unknown",
      permission: "denied",
      permissionGeneration: 5,
      historyExclusion: "recorded",
      payloadRevision: 1,
      caretCount: 3,
      usedWorkspaceFallback: true,
      payloadLength: 4,
    });
    expect(read).toMatchObject({
      outcome: "cancelled",
      systemEffect: "unknown",
      usedWorkspaceFallback: true,
      permission: "denied",
    });
    assertClipboardObservationIsRedacted(read);
  });

  it("never downgrades a performed effect and never carries payload text", () => {
    const direct = createClipboardWriteObservation({
      operation: "copy",
      result: { outcome: "success", systemEffect: "performed" },
      payload: { plainText: "secret", rectangular: false },
      permission: "granted",
      permissionGeneration: 1,
      historyExclusion: "recorded",
      payloadRevision: 0,
      caretCount: 1,
    });
    expect(direct.systemEffect).toBe("performed");
    assertClipboardObservationIsRedacted(direct);
  });
});
