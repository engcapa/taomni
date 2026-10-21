import { expect, it, vi } from "vitest";
import type { LspCodeAction } from "../../../../../lib/editor/lsp";
import { executeCodeAction } from "../../codeActionExecution";
import { toProviderActionsV4 } from "../../codeActionProviderAdapter";
import { IntentionSession, candidateFromProviderAction, verifyIntentionPreconditions } from "../../intentionSession";
import { testEvidenceInput } from "./harness";

export function registercodeActionProviderAdapterExecution3Cases() {
  it("freezes candidate list, marks timeout without losing candidates, and allows retry with new requestId", () => {
    const session = new IntentionSession();
    const action: LspCodeAction = {
      title: "Add import",
      kind: "quickfix",
      isPreferred: true,
      edit: null,
      command: null,
      commandArguments: null,
      raw: { data: {} },
    };

    const providerActions = toProviderActionsV4([action], testEvidenceInput);
    const candidates = providerActions.map((pa) => candidateFromProviderAction(pa.action, pa.evidence));

    const snapshot = session.open(candidates, {
      fileKey: "k1",
      uri: testEvidenceInput.uri,
      documentRevision: testEvidenceInput.revision,
      providerGeneration: testEvidenceInput.provider.generation,
      projectFingerprint: testEvidenceInput.projectFingerprint,
    });

    expect(snapshot.candidates).toHaveLength(1);
    const candidateId = snapshot.candidates[0].id;

    // Resolving
    session.markResolving(candidateId, "req-1");
    expect(session.getResolveState(candidateId)).toEqual({ status: "resolving", requestId: "req-1" });

    // Timeout: candidate remains in list, state becomes retryable with requestId
    session.markTimeout(candidateId, "req-1");
    const timeoutState = session.getResolveState(candidateId);
    expect(timeoutState.status).toBe("failed");
    if (timeoutState.status === "failed") {
      expect(timeoutState.retryable).toBe(true);
      expect(timeoutState.requestId).toBe("req-1");
      expect(timeoutState.message).toContain("timed out");
    }
    // Candidate still exists!
    expect(session.getCandidate(candidateId)).not.toBeNull();

    // Retry with new request id
    session.markResolving(candidateId, "req-2");
    expect(session.getResolveState(candidateId)).toEqual({ status: "resolving", requestId: "req-2" });

    session.markResolved(candidateId);
    expect(session.getResolveState(candidateId)).toEqual({ status: "resolved" });

    session.dispose();
  });

  it("verifies intention preconditions and blocks stale revisions or fingerprints", () => {
    const context = {
      fileKey: "k1",
      uri: "file:///App.java",
      documentRevision: 10,
      providerGeneration: 2,
      projectFingerprint: "fp-abc",
      openedAt: Date.now(),
    };

    // Exactly matching -> valid
    const ok = verifyIntentionPreconditions(context, {
      documentRevision: 10,
      providerGeneration: 2,
      projectFingerprint: "fp-abc",
    });
    expect(ok.valid).toBe(true);

    // Stale document revision -> blocked
    const staleDoc = verifyIntentionPreconditions(context, {
      documentRevision: 11,
      providerGeneration: 2,
      projectFingerprint: "fp-abc",
    });
    expect(staleDoc).toEqual({ valid: false, reason: "revision-changed" });

    // Stale provider generation -> blocked
    const staleGen = verifyIntentionPreconditions(context, {
      documentRevision: 10,
      providerGeneration: 3,
      projectFingerprint: "fp-abc",
    });
    expect(staleGen).toEqual({ valid: false, reason: "generation-changed" });

    // Changed project fingerprint -> blocked
    const staleFp = verifyIntentionPreconditions(context, {
      documentRevision: 10,
      providerGeneration: 2,
      projectFingerprint: "fp-xyz",
    });
    expect(staleFp).toEqual({ valid: false, reason: "fingerprint-changed" });
  });

  it("executeCodeAction rejects execution when precondition check fails", async () => {
    const action: LspCodeAction = {
      title: "Fix",
      kind: "quickfix",
      isPreferred: true,
      edit: { documentEdits: [] },
      command: null,
      commandArguments: null,
      raw: {},
    };

    const applyEdit = vi.fn();
    const executeCommand = vi.fn();

    const outcome = await executeCodeAction(
      action,
      { applyEdit, executeCommand },
      () => ({ valid: false, reason: "document-revision-advanced" }),
    );

    expect(outcome).toEqual({
      status: "stale-precondition",
      reason: "document-revision-advanced",
      outcomes: [],
    });
    expect(applyEdit).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });
}
