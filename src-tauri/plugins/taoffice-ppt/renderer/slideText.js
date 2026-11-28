import { diff } from "@codemirror/merge";
import { SaxesParser } from "saxes";

export const MAX_SLIDE_TEXT = 4096;
const DRAWING = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
]);
const PRESENTATION = new Set([
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
]);

function drawing(tag, local) {
  return tag?.local === local && DRAWING.has(tag.uri);
}

function presentation(tag, local) {
  return tag?.local === local && PRESENTATION.has(tag.uri);
}

function supportsTextBody(stack) {
  if (!presentation(stack[0], "sld") || !stack.some((tag) => presentation(tag, "spTree"))) return false;
  const body = stack.at(-2);
  const owner = stack.at(-3);
  return (presentation(body, "txBody") && presentation(owner, "sp"))
    || (drawing(body, "txBody") && drawing(owner, "tc"));
}

function validText(text) {
  return typeof text === "string" && text.length <= MAX_SLIDE_TEXT
    && !/[\u0000-\u001f\uFFFE\uFFFF\p{Cs}]/u.test(text);
}

export function slideParagraphs(xml) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const paragraphs = [];
  const visible = [];
  let paragraph;
  let span;
  let slide = false;
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    stack.push(tag);
    if (stack.length > 128) throw new Error("A presentation slide is nested too deeply.");
    if (stack.length === 1) slide = presentation(tag, "sld");

    if (!paragraph && drawing(tag, "p") && supportsTextBody(stack)) {
      paragraph = { depth: stack.length, supported: true, spans: [], visualText: "" };
      return;
    }
    if (!paragraph) return;
    const depth = stack.length - paragraph.depth;
    const child = stack[paragraph.depth];
    if (drawing(child, "pPr") || (drawing(child, "r") && drawing(stack[paragraph.depth + 1], "rPr"))) return;
    if (drawing(child, "endParaRPr") || (depth === 1 && drawing(tag, "r"))) return;
    if (depth === 2 && drawing(tag, "t") && drawing(parent, "r")) {
      span = {
        text: "",
        tagStart: xml.lastIndexOf("<", parser.position - 1),
        textStart: parser.position,
        tagName: tag.name,
        empty: tag.isSelfClosing,
        preserveSpace: tag.attributes["xml:space"]?.value === "preserve",
      };
    } else {
      paragraph.supported = false;
      if (drawing(tag, "br")) paragraph.visualText += "\n";
    }
  });
  parser.on("text", (text) => {
    if (paragraph && drawing(stack.at(-1), "t")) paragraph.visualText += text;
    if (span) span.text += text;
  });
  parser.on("cdata", (text) => {
    if (paragraph && drawing(stack.at(-1), "t")) paragraph.visualText += text;
    if (span) paragraph.supported = false;
  });
  const preventEditing = () => { if (span) paragraph.supported = false; };
  parser.on("comment", preventEditing);
  parser.on("processinginstruction", preventEditing);
  parser.on("doctype", () => { throw new Error("Presentation XML cannot declare a document type."); });
  parser.on("closetag", (tag) => {
    if (span && drawing(tag, "t")) {
      paragraph.spans.push({ ...span, textEnd: span.empty ? span.textStart : xml.lastIndexOf("</", parser.position - 1) });
      span = undefined;
    }
    if (paragraph && stack.length === paragraph.depth) {
      const text = paragraph.spans.map((entry) => entry.text).join("");
      if (paragraph.visualText.trim()) visible.push(paragraph.visualText);
      if (paragraph.supported && paragraph.spans.length && validText(text)) {
        paragraphs.push({ index: paragraphs.length, text, spans: paragraph.spans });
      }
      paragraph = undefined;
    }
    stack.pop();
  });
  parser.write(xml).close();
  if (!slide) throw new Error("A presentation slide is missing its XML root.");
  return { paragraphs, visible };
}

function redistribute(spans, original, updated) {
  if (spans.length === 1) return [updated];
  let offset = 0;
  const ranges = spans.map(({ text }) => {
    const start = offset;
    offset += text.length;
    return { start, end: offset };
  });
  const replacements = spans.map(({ text }) => text);

  for (const change of [...diff(original, updated, { scanLimit: 512 })].reverse()) {
    const inserted = updated.slice(change.fromB, change.toB);
    const owner = ranges.findIndex(({ end }) => change.fromA < end);
    const first = owner < 0 ? ranges.length - 1 : owner;
    for (let index = first; index < ranges.length; index++) {
      const { start, end } = ranges[index];
      if (index > first && start >= change.toA) break;
      const localStart = Math.max(0, change.fromA - start);
      const localEnd = Math.min(end, change.toA) - start;
      const value = replacements[index];
      const insertion = index === first ? inserted : "";
      replacements[index] = value.slice(0, localStart) + insertion + value.slice(localEnd);
    }
  }
  return replacements;
}

function escapedText(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function textTag(xml, span, text) {
  const original = xml.slice(span.tagStart, span.textStart);
  const tag = span.empty ? original.replace(/\s*\/>$/u, ">") : original;
  if (text.trim() === text || span.preserveSpace) return tag;
  if (/\bxml:space\s*=/u.test(tag)) return tag.replace(/(\sxml:space\s*=\s*)(["'])[^"']*\2/u, '$1"preserve"');
  return tag.slice(0, -1) + ' xml:space="preserve">';
}

export function patchSlideText(xml, paragraphs, edits) {
  const segments = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    if (!edits.has(paragraph.id)) continue;
    const value = edits.get(paragraph.id);
    if (!validText(value)) throw new Error("Slide text must be a single line of at most 4096 characters.");
    if (value === paragraph.text) continue;
    const replacement = redistribute(paragraph.spans, paragraph.text, value);
    for (const [index, span] of paragraph.spans.entries()) {
      if (replacement[index] === span.text) continue;
      const closeTag = span.empty ? "</" + span.tagName + ">" : "";
      segments.push(xml.slice(cursor, span.tagStart), textTag(xml, span, replacement[index]), escapedText(replacement[index]), closeTag);
      cursor = span.textEnd;
    }
  }
  if (!segments.length) return xml;
  segments.push(xml.slice(cursor));
  return segments.join("");
}
