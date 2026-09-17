import { afterEach, describe, expect, it } from "vitest";
import {
  applySaveRaceWriteFault,
  holdSaveRaceStage,
  installSaveRaceProbe,
  recordSaveRaceEvent,
  uninstallSaveRaceProbe,
  type SaveRaceGateStatus,
} from "./saveRaceProbe";
import { WorkspaceWriteError, type WorkspaceWriteAck } from "../../../lib/editor/workspace";

interface GateControl {
  arm(request: Record<string, unknown>): { ok: boolean; reason?: string };
  status(): SaveRaceGateStatus;
  release(request?: { reason?: string }): { ok: boolean; reason?: string };
  note(request: { label: string; value: unknown }): { ok: boolean };
  trace(): Array<{ event: string; revision?: number | null; detail?: Record<string, unknown> }>;
}

function gate(): GateControl {
  const control = (window as unknown as { __taomniQaSaveGate?: GateControl }).__taomniQaSaveGate;
  if (!control) throw new Error("save race gate is not installed");
  return control;
}

function writeAck(): WorkspaceWriteAck {
  return {
    file: {
      path: "edit.txt",
      text: "alpha\n",
      size: 6,
      mtime: 1,
      hash: "hash-written",
    },
    writtenHash: "hash-written",
    writtenByteLength: 6,
    intentHash: "hash-written",
    oldHash: "hash-old",
    atomicReplaceUsed: true,
  };
}

afterEach(() => {
  uninstallSaveRaceProbe();
});

describe("ED-PARITY-002 save race probe", () => {
  it("is inert without the QA installation: holds resolve and the fault passes the real ack through", async () => {
    const ack = writeAck();
    await holdSaveRaceStage({
      stage: "watcher",
      workspaceId: "w",
      fileKey: "f",
      transactionId: "t",
      filePath: "/tmp/edit.txt",
    });
    expect((window as unknown as { __taomniQaSaveGate?: unknown }).__taomniQaSaveGate).toBeUndefined();
    expect(await applySaveRaceWriteFault("/tmp/edit.txt", ack, null)).toBe(ack);
  });

  it("holds an armed stage, samples live revisions at enter and release, and consumes the arm", async () => {
    installSaveRaceProbe();
    let revision = 3;
    const control = gate();
    expect(control.arm({
      stage: "watcher",
      filePath: "/tmp/edit.txt",
      workspaceId: "w",
      fileKey: "f",
      transactionId: "t",
      timeoutMs: 5_000,
    })).toEqual({ ok: true, stage: "watcher" });

    const holding = holdSaveRaceStage({
      stage: "watcher",
      workspaceId: "w",
      fileKey: "f",
      transactionId: "t",
      filePath: "/tmp/edit.txt",
      revision: () => revision,
    });
    const status = control.status();
    expect(status.held).toMatchObject({ stage: "watcher", transactionId: "t" });
    expect(status.armed).toBeNull();

    revision = 7;
    expect(control.release()).toEqual({ ok: true });
    await holding;

    const events = control.trace();
    expect(events.map((entry) => entry.event)).toEqual(["arm", "enter", "release"]);
    expect(events[1].revision).toBe(3);
    expect(events[2].revision).toBe(7);
    expect(control.release()).toEqual({ ok: false, reason: "nothing-held" });
  });

  it("does not hold when the armed identity does not match the transaction", async () => {
    installSaveRaceProbe();
    gate().arm({ stage: "watcher", filePath: "/tmp/other.txt", timeoutMs: 5_000 });
    await holdSaveRaceStage({
      stage: "watcher",
      workspaceId: "w",
      fileKey: "f",
      transactionId: "t",
      filePath: "/tmp/edit.txt",
    });
    expect(gate().status().held).toBeNull();
    expect(gate().trace().map((entry) => entry.event)).toEqual(["arm"]);
  });

  it("releases a hold on timeout and records the reason", async () => {
    installSaveRaceProbe();
    gate().arm({ stage: "prepare", timeoutMs: 25 });
    const started = Date.now();
    await holdSaveRaceStage({
      stage: "prepare",
      workspaceId: "w",
      fileKey: "f",
      transactionId: "t",
      filePath: "/tmp/edit.txt",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    const release = gate().trace().find((entry) => entry.event === "timeout-release");
    expect(release?.detail?.reason).toBe("timeout-release");
    expect(gate().status().held).toBeNull();
  });

  it("releases a hold when the transaction owner becomes invalid", async () => {
    installSaveRaceProbe();
    gate().arm({ stage: "ack", timeoutMs: 5_000 });
    let valid = true;
    const holding = holdSaveRaceStage({
      stage: "ack",
      workspaceId: "w",
      fileKey: "f",
      transactionId: "t",
      filePath: "/tmp/edit.txt",
      stillValid: () => valid,
    });
    expect(gate().status().held).not.toBeNull();
    valid = false;
    await holding;
    expect(gate().trace().map((entry) => entry.event)).toContain("owner-invalidated");
  });

  it("withholds one real write response as a typed unknown-effect fault and records the real hashes", async () => {
    installSaveRaceProbe();
    gate().arm({ stage: "fault", filePath: "/tmp/edit.txt" });
    const ack = writeAck();
    try {
      await applySaveRaceWriteFault("/tmp/edit.txt", ack, null);
      throw new Error("expected the controlled fault to throw");
    } catch (error) {
      expect(error).toMatchObject({
        name: "WorkspaceWriteError",
        kind: "io",
        effect: "unknown",
        writtenHash: "hash-written",
        intentHash: "hash-written",
        writtenByteLength: 6,
        oldHash: "hash-old",
      });
    }
    const injected = gate().trace().find((entry) => entry.event === "fault-injected");
    expect(injected?.detail).toMatchObject({
      mode: "unknown-response",
      realOutcome: "acked",
      writtenHash: "hash-written",
    });
    // One-shot: the next real ack passes through untouched.
    expect(await applySaveRaceWriteFault("/tmp/edit.txt", ack, null)).toBe(ack);
  });

  it("delays a real write response behind the fault hold so the runner can mutate disk first", async () => {
    installSaveRaceProbe();
    gate().arm({
      stage: "fault",
      mode: "unknown-response-delay",
      filePath: "/tmp/edit.txt",
      timeoutMs: 5_000,
    });
    const ack = writeAck();
    const pending = applySaveRaceWriteFault("/tmp/edit.txt", ack, null);
    expect(gate().status().held).toMatchObject({ stage: "fault" });
    expect(gate().trace().map((entry) => entry.event)).toEqual(["arm", "fault-pending", "enter"]);
    gate().release();
    await expect(pending).rejects.toMatchObject({
      name: "WorkspaceWriteError",
      effect: "unknown",
      writtenHash: "hash-written",
    });
    expect(gate().trace().map((entry) => entry.event))
      .toEqual(["arm", "fault-pending", "enter", "release", "fault-injected"]);
  });

  it("carries real typed failure hashes into the delayed unknown fault", async () => {
    installSaveRaceProbe();
    gate().arm({
      stage: "fault",
      mode: "unknown-response-delay",
      filePath: "/tmp/edit.txt",
      timeoutMs: 5_000,
    });
    const realError = new WorkspaceWriteError(
      "io",
      "rename temp file: refused",
      undefined,
      undefined,
      "none",
      undefined,
      undefined,
      "hash-intended",
      7,
      "hash-old",
    );
    const pending = applySaveRaceWriteFault("/tmp/edit.txt", null, realError);
    gate().release();
    await expect(pending).rejects.toMatchObject({
      name: "WorkspaceWriteError",
      effect: "unknown",
      intentHash: "hash-intended",
      oldHash: "hash-old",
    });
    const injected = gate().trace().find((entry) => entry.event === "fault-injected");
    expect(injected?.detail).toMatchObject({ realOutcome: "failed", realErrorKind: "io" });
  });

  it("records runner DOM notes into the same timeline", () => {
    installSaveRaceProbe();
    expect(gate().note({ label: "focus", value: "cm-content" })).toEqual({ ok: true });
    expect(gate().note({ label: "", value: "x" })).toEqual({ ok: false });
    const note = gate().trace().find((entry) => entry.event === "note");
    expect(note?.detail).toEqual({ label: "focus", value: "cm-content" });
  });

  it("keeps recording production events only while installed", () => {
    recordSaveRaceEvent("writer-invoked", {
      workspaceId: "w",
      fileKey: "f",
      transactionId: "t",
      filePath: "/tmp/edit.txt",
    });
    installSaveRaceProbe();
    recordSaveRaceEvent("writer-invoked", {
      workspaceId: "w",
      fileKey: "f",
      transactionId: "t",
      filePath: "/tmp/edit.txt",
    });
    expect(gate().trace().map((entry) => entry.event)).toEqual(["writer-invoked"]);
  });
});
