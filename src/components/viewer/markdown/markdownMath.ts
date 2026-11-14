import katex from "katex";

const TOKEN_PREFIX = "taomni-math-";
const TOKEN_SUFFIX = "";
const MAX_FORMULA_LENGTH = 8_192;

type Formula = { token: string; source: string; display: boolean };

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function scanFormula(source: string, start: number, delimiter: "$$" | "$"): { end: number; value: string } | null {
  for (let cursor = start; cursor < source.length; cursor++) {
    if (source.startsWith(delimiter, cursor) && !isEscaped(source, cursor)) {
      const value = source.slice(start, cursor).trim();
      if (value && value.length <= MAX_FORMULA_LENGTH) return { end: cursor + delimiter.length, value };
    }
  }
  return null;
}

/** Replace math outside fenced code with inert tokens before marked parses it. */
export function replaceMarkdownMath(source: string): { content: string; formulas: Formula[] } {
  const formulas: Formula[] = [];
  let output = "";
  let cursor = 0;
  let fenced = false;
  while (cursor < source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const nextLine = lineEnd < 0 ? source.length : lineEnd + 1;
    const line = source.slice(cursor, nextLine);
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      output += line;
      cursor = nextLine;
      continue;
    }
    if (fenced) { output += line; cursor = nextLine; continue; }
    const delimiter = source.startsWith("$$", cursor) ? "$$" : source[cursor] === "$" ? "$" : null;
    if (!delimiter || (delimiter === "$" && source[cursor + 1] === "$")) {
      output += source[cursor++];
      continue;
    }
    const result = scanFormula(source, cursor + delimiter.length, delimiter);
    if (!result) { output += source[cursor++]; continue; }
    const formula = { token: `${TOKEN_PREFIX}${formulas.length}${TOKEN_SUFFIX}`, source: result.value, display: delimiter === "$$" };
    formulas.push(formula);
    output += formula.token;
    cursor = result.end;
  }
  return { content: output, formulas };
}

export function renderKatex(source: string, display: boolean): string {
  return katex.renderToString(source, {
    displayMode: display,
    output: "htmlAndMathml",
    throwOnError: false,
    trust: false,
    maxSize: 10,
  });
}

/** Replace inert tokens in an already sanitized Markdown tree with KaTeX output. */
export function enhanceMarkdownMath(root: HTMLElement, formulas: Formula[]): void {
  if (!formulas.length) return;
  const byToken = new Map(formulas.map((formula) => [formula.token, formula]));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue || "";
    const formula = formulas.find((candidate) => text.includes(candidate.token));
    if (!formula) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest("code,pre")) continue;
    const parts = text.split(formula.token);
    const fragment = document.createDocumentFragment();
    parts.forEach((part, index) => {
      if (part) fragment.append(document.createTextNode(part));
      if (index < parts.length - 1) {
        const wrapper = document.createElement("span");
        wrapper.className = formula.display ? "fv-md-math fv-md-math-display" : "fv-md-math";
        wrapper.innerHTML = renderKatex(formula.source, formula.display);
        fragment.append(wrapper);
      }
    });
    node.replaceWith(fragment);
    // A text node can contain multiple formula tokens. Process any remaining
    // tokens by walking the newly inserted subtree on the next call site.
    if (byToken.size > 1) enhanceMarkdownMath(parent, formulas.filter((item) => item.token !== formula.token));
  }
}
