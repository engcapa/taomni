import { EditorSelection, type EditorState } from "@codemirror/state";
import { moveLineDown, moveLineUp } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { Command } from "@codemirror/view";

export function statementNodeAt(state: EditorState, position: number) {
  let node = syntaxTree(state).resolveInner(position, -1);
  while (node.parent) {
    const name = node.name.toLowerCase();
    if (
      name.includes("statement")
      || name.includes("declaration")
      || name === "property"
      || name === "variabledefinition"
    ) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

export function moveStatement(direction: -1 | 1): Command {
  return (view) => {
    if (view.composing || view.state.readOnly) return false;
    const state = view.state;
    const main = state.selection.main;
    const node = statementNodeAt(state, main.head);
    if (!node) return direction < 0 ? moveLineUp(view) : moveLineDown(view);
    const sibling = direction < 0 ? node.prevSibling : node.nextSibling;
    if (!sibling || sibling.parent !== node.parent) {
      return direction < 0 ? moveLineUp(view) : moveLineDown(view);
    }
    const first = direction < 0 ? sibling : node;
    const second = direction < 0 ? node : sibling;
    const firstText = state.sliceDoc(first.from, first.to);
    const between = state.sliceDoc(first.to, second.from);
    const secondText = state.sliceDoc(second.from, second.to);
    const insert = `${secondText}${between}${firstText}`;
    const selectionOffset = direction < 0
      ? sibling.from - node.from
      : sibling.to - node.to;
    view.dispatch({
      changes: { from: first.from, to: second.to, insert },
      selection: EditorSelection.range(
        main.anchor + selectionOffset,
        main.head + selectionOffset,
      ),
      userEvent: "move.statement",
      scrollIntoView: true,
    });
    return true;
  };
}

export const moveStatementUp = moveStatement(-1);

export const moveStatementDown = moveStatement(1);

export const completeCurrentStatement: Command = (view) => {
  const state = view.state;
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  const lineText = line.text;
  const trimmed = lineText.trimEnd();
  const indent = lineText.match(/^\s*/)?.[0] ?? "";
  const trimmedContent = trimmed.trim();

  if (!trimmedContent || trimmedContent.startsWith("//") || trimmedContent.startsWith("#") || trimmedContent.startsWith("/*")) {
    const insertPos = line.to;
    const nextLineText = `\n${indent}`;
    view.dispatch({
      changes: { from: insertPos, insert: nextLineText },
      selection: { anchor: insertPos + nextLineText.length },
      scrollIntoView: true,
    });
    return true;
  }

  // Control flow headers with parens without braces: if (...), for (...), while (...), switch (...), catch (...)
  const controlHeaderMatch = trimmed.match(/^(.*\b(?:if|for|while|switch|catch)\s*\(.*\))\s*$/);
  if (controlHeaderMatch && !trimmed.endsWith("{")) {
    const insertText = ` {\n${indent}  \n${indent}}`;
    const changeFrom = line.from + trimmed.length;
    const cursorTarget = line.from + trimmed.length + 3 + indent.length + 2;
    view.dispatch({
      changes: { from: changeFrom, to: line.to, insert: insertText },
      selection: { anchor: cursorTarget },
      scrollIntoView: true,
    });
    return true;
  }

  // Control flow keywords without braces: else, try, finally, do
  const controlKeywordMatch = trimmed.match(/^(.*\b(?:else|try|finally|do))\s*$/);
  if (controlKeywordMatch && !trimmed.endsWith("{")) {
    const insertText = ` {\n${indent}  \n${indent}}`;
    const changeFrom = line.from + trimmed.length;
    const cursorTarget = line.from + trimmed.length + 3 + indent.length + 2;
    view.dispatch({
      changes: { from: changeFrom, to: line.to, insert: insertText },
      selection: { anchor: cursorTarget },
      scrollIntoView: true,
    });
    return true;
  }

  // Line ends with '{' or ':' -> open block with indent
  if (trimmed.endsWith("{") || trimmed.endsWith(":")) {
    const insertText = `\n${indent}  `;
    const changeFrom = line.from + trimmed.length;
    view.dispatch({
      changes: { from: changeFrom, to: line.to, insert: insertText },
      selection: { anchor: changeFrom + insertText.length },
      scrollIntoView: true,
    });
    return true;
  }

  // Line already ends with ';' -> newline below with same indent
  if (trimmed.endsWith(";")) {
    const insertText = `\n${indent}`;
    const changeFrom = line.from + trimmed.length;
    view.dispatch({
      changes: { from: changeFrom, to: line.to, insert: insertText },
      selection: { anchor: changeFrom + insertText.length },
      scrollIntoView: true,
    });
    return true;
  }

  // Standard statement needing ';' and newline (balance unclosed parens/brackets if any)
  let openParens = 0;
  let openBrackets = 0;
  let inString: string | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (inString) {
      if (char === inString && trimmed[i - 1] !== "\\") inString = null;
    } else if (char === '"' || char === "'" || char === "`") {
      inString = char;
    } else if (char === "(") {
      openParens++;
    } else if (char === ")") {
      if (openParens > 0) openParens--;
    } else if (char === "[") {
      openBrackets++;
    } else if (char === "]") {
      if (openBrackets > 0) openBrackets--;
    }
  }

  let closing = "";
  while (openParens > 0) { closing += ")"; openParens--; }
  while (openBrackets > 0) { closing += "]"; openBrackets--; }
  const append = `${closing};\n${indent}`;
  const changeFrom = line.from + trimmed.length;
  view.dispatch({
    changes: { from: changeFrom, to: line.to, insert: append },
    selection: { anchor: changeFrom + append.length },
    scrollIntoView: true,
  });
  return true;
};
