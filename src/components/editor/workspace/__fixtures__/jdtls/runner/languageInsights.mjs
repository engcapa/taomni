

export async function requestSignatureHelp(client, uri, position) {
  const startedAt = Date.now();
  const result = await client.request("textDocument/signatureHelp", {
    textDocument: { uri },
    position,
    context: { triggerKind: 1, isRetrigger: false },
  });
  return { result, ms: Date.now() - startedAt };
}


/**
 * Poll signatureHelp until the expectation predicate passes (the importer
 * may still be warming up after a fresh session).
 */
export async function waitForSignature(client, uri, position, expectFn, budgetMs) {
  const attempts = [];
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { result, ms } = await requestSignatureHelp(client, uri, position);
    attempts.push({ ms, signaturesCount: result?.signatures?.length ?? 0 });
    const evaluation = expectFn(result ?? {});
    if (evaluation.ok) {
      return { attempts, final: result ?? {}, satisfied: true, evaluation };
    }
    if (Date.now() > deadline) {
      return { attempts, final: result ?? {}, satisfied: false, evaluation };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  }
}


export function evaluateSignatureExpect(expect, result) {
  const signatures = result?.signatures ?? [];
  if (expect.minSignatures !== undefined && signatures.length < expect.minSignatures) {
    return { ok: false, reason: `expected ≥${expect.minSignatures} signatures, got ${signatures.length}` };
  }
  if (
    expect.labelContains !== undefined
    && !signatures.some((signature) => String(signature.label ?? "").includes(expect.labelContains))
  ) {
    return {
      ok: false,
      reason: `no signature label containing ${expect.labelContains}; saw ${signatures.map((s) => s.label).slice(0, 6).join(" | ")}`,
    };
  }
  if (expect.activeParameterEquals !== undefined && result.activeParameter !== expect.activeParameterEquals) {
    return {
      ok: false,
      reason: `expected activeParameter=${expect.activeParameterEquals}, got ${result.activeParameter} (${signatures.map((s) => s.label).slice(0, 4).join(" | ")})`,
    };
  }
  return { ok: true };
}


/** Normalize hover contents into plain text + a coarse kind tag. */
export function hoverText(contents) {
  if (!contents) return { text: "", kind: null };
  if (typeof contents === "string") return { text: contents, kind: "plaintext" };
  if (Array.isArray(contents)) return { text: contents.map((c) => hoverText(c).text).join("\n"), kind: "markup-array" };
  if (contents.kind && typeof contents.value === "string") return { text: contents.value, kind: contents.kind };
  if (typeof contents.value === "string") return { text: contents.value, kind: "marked-string" };
  return { text: "", kind: "unknown" };
}


export function httpsLinksIn(text) {
  return [...new Set(String(text).match(/https:\/\/[^\s<>"')\]]+/g) ?? [])];
}
