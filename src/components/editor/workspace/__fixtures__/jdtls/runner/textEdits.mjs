

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

/**
 * LSP position (0-based) of the END of the completion target token. Targets
 * are bare-token lines inside `completionTargets()` blocks, so matching a
 * whole trimmed line disambiguates from the same identifier used in compiled
 * code earlier in the file.
 */
export function locateTokenEnd(text, needle) {
  const lines = text.split("\n");
  const target = needle.trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== target) continue;
    const indent = line.length - line.trimStart().length;
    return { line: i, character: indent + target.length };
  }
  // Fallback: member-completion targets end a line with the prefix, e.g.
  // `new StringBuilder().appen`.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trimEnd().endsWith(target)) continue;
    const indent = line.length - line.trimStart().length;
    return { line: i, character: indent + line.trim().length };
  }
  throw new Error(`bare token line ${JSON.stringify(needle)} not found in fixture source`);
}


export function itemsFrom(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : (result.items ?? []);
}


/**
 * Normalize TextEdit vs InsertReplaceEdit (the client advertises
 * insertReplaceSupport, so jdtls may answer with {insert, replace, newText}).
 * Acceptance simulation applies the REPLACE range — IDEA semantics for
 * accepting over the typed prefix.
 */
export function normalizeEdit(edit) {
  if (!edit) return null;
  const range = edit.range ?? edit.replace ?? edit.insert ?? null;
  if (!range || !range.start || !range.end) return null;
  return { range: { start: range.start, end: range.end }, newText: String(edit.newText ?? "") };
}


/** Absolute UTF-16 offset of an LSP position inside one exact text. */
export function absOffset(text, position) {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < position.line; i++) {
    if (i >= lines.length) throw new Error(`position line ${position.line} outside document`);
    offset += lines[i].length + 1;
  }
  return offset + position.character;
}


/**
 * Apply the merged acceptance EXACTLY like a CodeMirror change set: every
 * edit is converted to an absolute PRE-image offset first, then applied
 * descending so earlier replacements never shift later offsets.
 * @returns {{applied: string, undo: () => string}}
 */
export function simulateAcceptance(original, primaryEdit, additionalEdits) {
  const planned = [primaryEdit, ...additionalEdits]
    .map((edit) => ({
      start: absOffset(original, edit.range.start),
      end: absOffset(original, edit.range.end),
      newText: edit.newText,
      previous: original.slice(
        absOffset(original, edit.range.start),
        absOffset(original, edit.range.end),
      ),
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = original;
  // Inverses carry POST-image spans. Edits are applied descending, so every
  // later (lower-offset) edit shifts all previously recorded inverse spans
  // by its length delta — tracked here so undo() is exact.
  const inverses = [];
  for (const edit of planned) {
    if (edit.end > out.length || edit.start > edit.end) {
      throw new Error(`edit range [${edit.start},${edit.end}) invalid for length ${out.length}`);
    }
    const delta = edit.newText.length - (edit.end - edit.start);
    if (delta !== 0) {
      for (const inverse of inverses) {
        if (inverse.start >= edit.end) {
          inverse.start += delta;
          inverse.end += delta;
        }
      }
    }
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
    inverses.push({ start: edit.start, end: edit.start + edit.newText.length, previous: edit.previous });
  }
  return {
    applied: out,
    undo() {
      let restored = out;
      // Recorded descending; restoring in the same order never disturbs
      // already-restored higher spans.
      for (const inverse of inverses) {
        restored = restored.slice(0, inverse.start) + inverse.previous + restored.slice(inverse.end);
      }
      return restored;
    },
  };
}


export function editOrderKey(edit) {
  return edit.range.start.line * 1_000_000 + edit.range.start.character;
}


// ---------------------------------------------------------------------------
// W1 reference-information scenarios (§8.20.2)
// ---------------------------------------------------------------------------

/** Locate a line by its trimmed content; returns the 0-based line + indent. */
export function locateLineByContent(text, needle) {
  const lines = text.split("\n");
  const target = needle.trim();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== target) continue;
    return { line: i, indent: lines[i].length - lines[i].trimStart().length };
  }
  throw new Error(`line ${JSON.stringify(needle)} not found in fixture source`);
}


/** Caret right after `prefix` inside the located line (unique substring). */
export function locateAfterPrefix(text, lineContent, prefix) {
  const { line } = locateLineByContent(text, lineContent);
  const raw = text.split("\n")[line];
  const index = raw.indexOf(prefix);
  if (index < 0) throw new Error(`prefix ${JSON.stringify(prefix)} not found on line ${JSON.stringify(lineContent)}`);
  return { line, character: index + prefix.length };
}


/** Caret at the middle of `token` inside the located line (hover target). */
export function locateTokenInLine(text, lineContent, token) {
  const { line } = locateLineByContent(text, lineContent);
  const raw = text.split("\n")[line];
  const index = raw.indexOf(token);
  if (index < 0) throw new Error(`token ${JSON.stringify(token)} not found on line ${JSON.stringify(lineContent)}`);
  return { line, character: index + Math.floor(token.length / 2) };
}
