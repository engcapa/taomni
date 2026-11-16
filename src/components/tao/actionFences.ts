export interface ActionFence { from: number; to: number; body: string }

/** A JSON string can contain Markdown fences, quotes and escaped backslashes.
 * A closing marker inside that string is file content, not the action end. */
export function actionFences(text: string): ActionFence[] {
  const fences: ActionFence[] = [];
  const opening = /(`{3,})tao-action\b[ \t]*(?:\r?\n)?/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text))) {
    const start = opening.lastIndex;
    let quoted = false, escaped = false, found = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character !== "`" || !text.startsWith(match[1], index)) continue;
      let end = index + match[1].length;
      while (text[end] === "`") end++;
      fences.push({ from: match.index, to: end, body: text.slice(start, index) });
      opening.lastIndex = end; found = true; break;
    }
    // An unclosed quoted payload is not an executable batch. Keep it visible.
    if (!found) break;
  }
  return fences;
}
