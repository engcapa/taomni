import { itemsFrom } from "./textEdits.mjs";


export async function requestCompletion(client, uri, position, trigger) {
  const startedAt = Date.now();
  const result = await client.request("textDocument/completion", {
    textDocument: { uri },
    position,
    context: trigger
      ? { triggerKind: 2, triggerCharacter: trigger }
      : { triggerKind: 1 },
  });
  return { result, ms: Date.now() - startedAt };
}


/**
 * Poll completion until the expectation predicate passes (project import can
 * take minutes on first contact) or the budget runs out.
 */
export async function waitForCase(client, uri, position, trigger, expectFn, budgetMs) {
  const attempts = [];
  const deadline = Date.now() + budgetMs;
  let last = null;
  for (;;) {
    const { result, ms } = await requestCompletion(client, uri, position, trigger);
    last = { result, ms };
    attempts.push({ ms, itemCount: itemsFrom(result).length });
    const evaluation = expectFn(itemsFrom(result));
    if (evaluation.ok) {
      return { attempts, final: result, msToSatisfy: Date.now() - (deadline - budgetMs), satisfied: true, evaluation };
    }
    if (Date.now() > deadline) {
      return { attempts, final: result, satisfied: false, evaluation };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  }
}


/** jdtls decorates labels ("String - java.lang", "asList(int…)"); strip it. */
export function baseLabel(item) {
  return String(item.label ?? "").split(" - ")[0].split("(")[0].trim();
}


export function evaluateExpect(expect, items) {
  if (!expect) return { ok: true };
  const labels = items.map((item) => item.label ?? "");
  if (expect.labelEquals !== undefined) {
    const labelHits = items.filter((item) => baseLabel(item) === expect.labelEquals);
    if (labelHits.length === 0) {
      return { ok: false, reason: `no item labelled ${expect.labelEquals}; saw ${labels.slice(0, 12).join(", ")}` };
    }
    // Same-name twins are disambiguated by detail (FQ name): only a candidate
    // whose detail carries the expected package proves the right source.
    const hit = expect.detailContains
      ? labelHits.find((item) => String(item.detail ?? "").includes(expect.detailContains))
      : labelHits[0];
    if (!hit) {
      return {
        ok: false,
        reason: `${expect.labelEquals} candidates lack expected detail ${expect.detailContains}: ${labelHits.map((item) => item.detail ?? "?").join(" | ")}`,
      };
    }
    return { ok: true, matchedItem: hit, matchedDetail: hit.detail ?? null };
  }
  if (expect.labelStartsWith !== undefined) {
    const hit = items.find((item) => baseLabel(item).startsWith(expect.labelStartsWith));
    if (!hit) return { ok: false, reason: `no item starting with ${expect.labelStartsWith}` };
    return { ok: true, matchedItem: hit };
  }
  if (expect.anyLabelIn !== undefined) {
    const hit = items.find((item) => expect.anyLabelIn.includes(baseLabel(item)));
    if (!hit) return { ok: false, reason: `none of ${expect.anyLabelIn.join("/")} present; saw ${labels.slice(0, 12).join(", ")}` };
    return { ok: true, matchedItem: hit };
  }
  if (expect.labelAbsent !== undefined) {
    const bad = items.filter((item) => baseLabel(item).includes(expect.labelAbsent));
    if (bad.length > 0) return { ok: false, reason: `${expect.labelAbsent} unexpectedly completed (${bad[0].detail ?? ""})` };
    return { ok: true };
  }
  if (expect.distinctDetailCountForLabelMin !== undefined) {
    const [label, min] = expect.distinctDetailCountForLabelMin;
    // Same-name ambiguity shows up as identical labels with distinct details;
    // fall back to the raw label when decoration is absent.
    const twins = items.filter((item) => baseLabel(item) === label);
    const identities = new Set(twins.map((item) => String(item.detail ?? "") || String(item.label)));
    if (identities.size < min) {
      return { ok: false, reason: `expected ≥${min} distinct candidates for ${label}, got ${identities.size}: ${[...identities].join(" | ")}` };
    }
    return { ok: true, distinctDetails: [...identities], matchedItem: twins[0] };
  }
  return { ok: true };
}
