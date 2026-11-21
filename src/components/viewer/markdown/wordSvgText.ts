type Glyph = { paint: Element; value: string; x: number; y: number };
type TextLayout = { owner: SVGTextElement; glyphs: Glyph[] };

// Keep contextual shaping, bidi, combining marks and text paths owned by SVG.
const contextual = /[\p{Mark}\p{Script=Arabic}\p{Script=Hebrew}\u0900-\u0fff\u200c\u200d]/u;
const coordinates = new Set(["id", "class", "x", "y", "dx", "dy", "rotate", "transform", "textLength", "lengthAdjust", "text-anchor"]);

function measureText(owner: SVGTextElement): TextLayout | undefined {
  const value = owner.textContent || "";
  // Office-family SVG importers do not reliably honor text-anchor,
  // dominant-baseline or relative tspan coordinate chains: C4-style row
  // tspans center-anchored at x=0 render as start-anchored runs, pushing every
  // label to the right half of its box. Pin the measured layout of every
  // plain label, Latin or CJK alike.
  if (!value.trim() || contextual.test(value) || owner.hasAttribute("rotate")
    || owner.querySelector("textPath,[rotate],[transform]") || typeof owner.getNumberOfChars !== "function") return;
  try {
    // Do not rewrite collapsed whitespace or text with unavailable geometry.
    if (owner.getNumberOfChars() !== value.length) return;
    const glyphs: Glyph[] = [];
    const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const paint = node.parentElement;
      if (!paint) return;
      for (const character of node.textContent || "") {
        const point = owner.getStartPositionOfChar(offset);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        const last = glyphs[glyphs.length - 1];
        // Keep Latin runs together so their kerning and ligatures survive.
        if (/^[\x20-\x7e]$/.test(character) && last?.paint === paint && /^[\x20-\x7e]+$/.test(last.value) && last.y === point.y) {
          last.value += character;
        } else {
          glyphs.push({ paint, value: character, x: point.x, y: point.y });
        }
        offset += character.length;
      }
    }
    return glyphs.length ? { owner, glyphs } : undefined;
  } catch { return; }
}

/** Measure before freezing the CSS cascade; apply after presentation attributes
 * are available. Office importers re-flow labels with their own fonts and do
 * not reliably honor text-anchor, dominant-baseline or relative tspan
 * coordinates: fallback metrics can clip CJK runs and importer bugs push
 * anchor-agnostic labels off center. Explicit glyph positions retain the
 * measured font and placement for every plain label. */
export function captureWordTextLayout(svg: SVGSVGElement): () => void {
  const layouts = Array.from(svg.querySelectorAll<SVGTextElement>("text"))
    .map(measureText).filter((layout): layout is TextLayout => Boolean(layout));
  return () => {
    for (const { owner, glyphs } of layouts) {
      const spans = glyphs.map(({ paint, value, x, y }) => {
        const span = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
        for (const attribute of Array.from(paint.attributes)) {
          if (!coordinates.has(attribute.name)) span.setAttribute(attribute.name, attribute.value);
        }
        span.setAttribute("x", String(x)); span.setAttribute("y", String(y));
        span.setAttribute("text-anchor", "start"); span.textContent = value;
        return span;
      });
      for (const name of ["x", "y", "dx", "dy", "textLength", "lengthAdjust"]) owner.removeAttribute(name);
      owner.setAttribute("text-anchor", "start");
      owner.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      owner.replaceChildren(...spans);
    }
  };
}
