import { join } from "node:path";
import { sha256 } from "./lsp-client.mjs";
import { openFile } from "./session.mjs";
import { locateTokenInLine, normalizeEdit, simulateAcceptance } from "./textEdits.mjs";


// ---------------------------------------------------------------------------
// §8.20.4 W3: unresolved-type + import quick fix over real jdtls
// ---------------------------------------------------------------------------

export async function runQuickFixScenario(session, spec) {
  const record = {
    caseId: spec.id,
    file: spec.file,
    diagnosticMessage: null,
    actionTitle: null,
    actionKind: null,
    isPreferred: null,
    offeredTitles: [],
    resolved: false,
    resolveFailure: null,
    importInsertText: null,
    appliedSha256: null,
    originalSha256: null,
    revertedRestoresOriginalHash: false,
    msTotal: 0,
    satisfied: false,
    reason: null,
  };
  const startedAt = Date.now();
  const abs = join(session.projectDir, spec.file);
  const uri = `file://${abs}`;
  const text = openFile(session.client, session.projectDir, spec.file);
  // Precise caret range for the simple name (pushed publishDiagnostics carry
  // no range in this runner's reduced log; the fixture line is fixed).
  const symbolPos = locateTokenInLine(
    text,
    'boolean blank = StringUtils.isBlank("x");',
    spec.symbol,
  );
  const symbolRange = {
    start: symbolPos,
    end: { line: symbolPos.line, character: symbolPos.character + spec.symbol.length },
  };

  // Poll for the unresolved-symbol diagnostic exactly the way production
  // receives it: server-PUSHED publishDiagnostics (the runner logs those),
  // falling back to a workspace pull request when push stays silent.
  let diagnostic = null;
  const deadline = Date.now() + 240_000;
  while (!diagnostic && Date.now() < deadline) {
    // Preferred: the RAW pushed payload — echoing the server's own object
    // (exact code + range) back as context is what jdtls matches against.
    const rawKey = [...session.rawDiagnosticsByUri.keys()]
      .find((key) => key.endsWith(spec.file));
    const rawItems = rawKey ? session.rawDiagnosticsByUri.get(rawKey) ?? [] : [];
    diagnostic = rawItems.find((item) => (
      typeof item.message === "string"
      && item.message.includes(spec.symbol)
      && /cannot be resolved/i.test(item.message)
    )) ?? null;
    if (!diagnostic) {
      // Fallback: reduced log + synthesized precise symbol range.
      const pushed = session.diagnosticsLog
        .filter((entry) => entry.uriSanitized.endsWith(spec.file))
        .find((entry) => (
          entry.message.includes(spec.symbol)
          && /cannot be resolved/i.test(entry.message)
        ));
      if (pushed) {
        diagnostic = {
          range: symbolRange,
          message: pushed.message,
          severity: pushed.severity,
          source: pushed.source,
        };
      }
    }
    if (!diagnostic) await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  }
  if (!diagnostic) {
    record.reason = `unresolved ${spec.symbol} diagnostic never appeared`;
    record.msTotal = Date.now() - startedAt;
    return record;
  }
  record.diagnosticMessage = String(diagnostic.message).split("\n")[0];

  // jdtls may answer an EMPTY literal list while a (re-)import settles or
  // while it reconciles the very diagnostic just published — poll until the
  // provider offers something or the budget runs out.
  const codeActionParams = {
    textDocument: { uri },
    range: diagnostic.range,
    context: { diagnostics: [diagnostic], triggerKind: 2 },
  };
  let list = [];
  let codeActionTimeouts = 0;
  const actionDeadline = Date.now() + 180_000;
  while (list.length === 0 && Date.now() < actionDeadline) {
    const actions = await session.client.request(
      "textDocument/codeAction",
      codeActionParams,
      240_000,
    ).catch(() => null);
    if (actions === null) codeActionTimeouts += 1;
    list = Array.isArray(actions) ? actions : [];
    if (list.length === 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    }
  }
  record.offeredTitles = list.map((action) => action.title).slice(0, 8);
  const importActions = list.filter((action) => (
    /^import /i.test(action.title ?? "") && (action.title ?? "").includes(spec.symbol)
  ));
  const picked = importActions.find((action) => (
    !spec.expectedDetailContains
    || `${action.title ?? ""} ${action.detail ?? ""}`.includes(spec.expectedDetailContains)
  )) ?? null;
  if (!picked) {
    // Keep a provider timeout distinct from an answered response that simply
    // lacks the requested import. Neither outcome is an apply success.
    if (list.length === 0 && codeActionTimeouts > 0) {
      record.providerHang = { attempts: codeActionTimeouts };
      record.reason = `provider-hang: textDocument/codeAction gave no response across ${codeActionTimeouts} attempt(s) (healthy + broken files alike)`;
    } else {
      record.reason = `no import quick fix offered; saw ${record.offeredTitles.join(" | ") || "nothing"}`;
    }
    record.msTotal = Date.now() - startedAt;
    return record;
  }
  record.actionTitle = picked.title;
  record.actionKind = picked.kind ?? null;
  record.isPreferred = picked.isPreferred === true;

  let merged = picked;
  if (picked.data !== undefined) {
    try {
      const resolvedAction = await session.client.request("codeAction/resolve", picked);
      record.resolved = true;
      merged = { ...picked, ...(resolvedAction ?? {}) };
      record.resolvedShape = summarizeCodeActionShape(merged);
    } catch (error) {
      record.resolveFailure = error.message.split("\n")[0];
      // Keep the raw action; some servers answer edits inline despite data.
    }
  }

  const targetEdits = merged.edit?.changes?.[uri]
    ?? merged.edit?.changes?.[encodeURI(uri)]
    ?? (merged.edit?.documentChanges ?? [])
      .filter((change) => change.textDocument?.uri === uri || change.textDocument?.uri === encodeURI(uri))
      .flatMap((change) => change.edits ?? []);
  if (record.resolvedShape) {
    record.resolvedShape.requestedUri = uri;
    record.resolvedShape.exactUriMatch = Array.isArray(merged.edit?.changes?.[uri]);
    record.resolvedShape.encodedUriMatch = Array.isArray(merged.edit?.changes?.[encodeURI(uri)]);
    record.resolvedShape.targetEditShapes = targetEdits.map((edit) => ({
      keys: edit && typeof edit === "object" ? Object.keys(edit).sort() : [],
      rangeKeys: edit?.range && typeof edit.range === "object" ? Object.keys(edit.range).sort() : [],
      newTextType: typeof edit?.newText,
      newTextLength: typeof edit?.newText === "string" ? edit.newText.length : null,
      containsImport: typeof edit?.newText === "string" && /(?:^|\n)\s*import\s+/.test(edit.newText),
    }));
  }
  const normalized = targetEdits.map(normalizeEdit).filter(Boolean);
  const importEdit = normalized.find((edit) => /(?:^|\n)\s*import\s+/.test(edit.newText));
  if (!normalized.length || !importEdit) {
    record.reason = "quick fix produced no import edit for this document";
    record.msTotal = Date.now() - startedAt;
    return record;
  }
  record.importInsertText = importEdit.newText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^import\s+/.test(line))
    .join("\n");
  record.originalSha256 = sha256(text);
  const simulation = simulateAcceptance(text, normalized[0], normalized.slice(1));
  record.appliedSha256 = sha256(simulation.applied);
  const restored = simulation.undo();
  record.revertedRestoresOriginalHash = sha256(restored) === record.originalSha256;
  record.satisfied = record.revertedRestoresOriginalHash
    && record.appliedSha256 !== record.originalSha256;
  if (!record.satisfied) {
    record.reason = record.revertedRestoresOriginalHash
      ? "post-image equals original (no visible change applied)"
      : "undo did not restore the original hash";
  }

  // Cancel probe mirrors the production bridge: fire, cancel on the wire,
  // record whatever the provider does (null / -32800 / still-full are all
  // honest outcomes worth pinning per provider version).
  const probeParams = {
    textDocument: { uri },
    range: diagnostic.range,
    context: { diagnostics: [diagnostic], triggerKind: 2 },
  };
  const tracked = session.client.requestTracked("textDocument/codeAction", probeParams);
  session.client.cancelRequest(tracked.id);
  try {
    const value = await tracked.promise;
    record.quickFixCancel = {
      outcome: "resolved",
      empty: !Array.isArray(value) || value.length === 0,
    };
  } catch (error) {
    record.quickFixCancel = { outcome: `rejected:${error.code ?? "?"}` };
  }
  record.msTotal = Date.now() - startedAt;
  return record;
}


export function summarizeCodeActionShape(action) {
  const edit = action?.edit && typeof action.edit === "object" ? action.edit : null;
  const changes = edit?.changes && typeof edit.changes === "object" ? edit.changes : null;
  const documentChanges = Array.isArray(edit?.documentChanges) ? edit.documentChanges : [];
  return {
    actionKeys: action && typeof action === "object" ? Object.keys(action).sort() : [],
    command: typeof action?.command === "string" ? action.command : null,
    commandArgumentCount: Array.isArray(action?.arguments) ? action.arguments.length : null,
    editKeys: edit ? Object.keys(edit).sort() : [],
    changeUris: changes ? Object.keys(changes).sort() : [],
    changeEditCounts: changes
      ? Object.values(changes).map((edits) => (Array.isArray(edits) ? edits.length : null))
      : [],
    documentChanges: documentChanges.map((change) => ({
      keys: change && typeof change === "object" ? Object.keys(change).sort() : [],
      uri: change?.textDocument?.uri ?? null,
      editCount: Array.isArray(change?.edits) ? change.edits.length : null,
    })),
  };
}
