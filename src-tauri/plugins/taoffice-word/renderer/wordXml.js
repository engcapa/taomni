import { SaxesParser } from "saxes";
import { distributeText } from "./wordTextChanges.js";

const WORD_NS = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
export const MAX_PARAGRAPH_LENGTH = 4096;

const isWord = (tag, name) => WORD_NS.has(tag?.uri) && tag.local === name;
const TABLE_PATH = ["tbl", "tr", "tc"];
const PARAGRAPH_MARKERS = new Set(["bookmarkStart", "bookmarkEnd", "proofErr", "commentRangeStart", "commentRangeEnd"]);

function tableDepth(stack) {
  if (!isWord(stack[0], "document") || !isWord(stack[1], "body")) return -1;
  const ancestors = stack.slice(2, -1);
  if (ancestors.length % TABLE_PATH.length !== 0
    || ancestors.some((tag, index) => !isWord(tag, TABLE_PATH[index % TABLE_PATH.length]))) return -1;
  return ancestors.length / TABLE_PATH.length;
}

export function editableParagraphs(xml) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const paragraphs = [];
  let body = false;
  let paragraphIndex = -1;
  let paragraph;
  let span;
  parser.on("doctype", () => { throw new Error("DOCX XML declarations must not contain a document type."); });
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    stack.push(tag);
    if (stack.length > 128) throw new Error("The Word document is nested too deeply.");
    if (isWord(tag, "p")) paragraphIndex++;
    if (stack.length === 2 && isWord(stack[0], "document") && isWord(tag, "body")) body = true;
    if (!paragraph && isWord(tag, "p")) {
      const depth = tableDepth(stack);
      if (depth >= 0) paragraph = { depth: stack.length, index: paragraphIndex, tableDepth: depth, supported: true, spans: [] };
      return;
    }
    if (!paragraph?.supported) return;
    const level = stack.length - paragraph.depth;
    const child = stack[paragraph.depth];
    if (isWord(child, "pPr") || (isWord(child, "r") && isWord(stack[paragraph.depth + 1], "rPr"))) return;
    if (level === 1 && (isWord(tag, "r") || (tag.isSelfClosing && WORD_NS.has(tag.uri) && PARAGRAPH_MARKERS.has(tag.local)))) return;
    if (level === 2 && isWord(parent, "r") && isWord(tag, "t")) {
      span = {
        text: "",
        tagStart: xml.lastIndexOf("<", parser.position - 1),
        valueStart: parser.position,
        space: tag.attributes["xml:space"]?.value,
        closeTag: tag.isSelfClosing ? `</${tag.name}>` : "",
      };
      return;
    }
    paragraph.supported = false;
  });
  parser.on("text", (text) => { if (span) span.text += text; });
  const preserveTextMarkup = () => { if (span) paragraph.supported = false; };
  parser.on("cdata", preserveTextMarkup);
  parser.on("comment", preserveTextMarkup);
  parser.on("processinginstruction", preserveTextMarkup);
  parser.on("closetag", (tag) => {
    if (span && stack.length === paragraph.depth + 2 && isWord(tag, "t")) {
      paragraph.spans.push({ ...span, valueEnd: span.closeTag ? span.valueStart : xml.lastIndexOf("</", parser.position - 1) });
      span = undefined;
    }
    if (paragraph && stack.length === paragraph.depth) {
      const text = paragraph.spans.map((entry) => entry.text).join("");
      if (paragraph.supported && paragraph.spans.length && validText(text)) {
        paragraphs.push({ id: paragraphs.length, index: paragraph.index, tableDepth: paragraph.tableDepth, text, spans: paragraph.spans });
      }
      paragraph = undefined;
    }
    stack.pop();
  });
  parser.write(xml).close();
  if (!body) throw new Error("The DOCX package has no Word document body.");
  return paragraphs;
}

function xmlText(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function validText(value) {
  return typeof value === "string" && value.length <= MAX_PARAGRAPH_LENGTH
    && !/[\u0000-\u001f\uFFFE\uFFFF\p{Cs}]/u.test(value);
}

function textTag(xml, span, value) {
  const original = xml.slice(span.tagStart, span.valueStart);
  const startTag = span.closeTag ? original.replace(/\s*\/>$/u, ">") : original;
  if (value === value.trim() || span.space === "preserve") return startTag;
  if (span.space === undefined) return `${startTag.slice(0, -1)} xml:space="preserve">`;
  return startTag.replace(/(\sxml:space\s*=\s*)(["'])[^"']*\2/u, '$1"preserve"');
}

export function patchParagraphs(xml, paragraphs, edits) {
  let cursor = 0;
  const pieces = [];
  for (const paragraph of paragraphs) {
    if (!edits.has(paragraph.id)) continue;
    const value = edits.get(paragraph.id);
    if (!validText(value)) {
      throw new Error("Use one line of text with up to 4096 characters per paragraph.");
    }
    if (value === paragraph.text) continue;
    const replacements = distributeText(paragraph.spans, paragraph.text, value);
    for (const [index, span] of paragraph.spans.entries()) {
      const replacement = replacements[index];
      if (span.text === replacement) continue;
      pieces.push(xml.slice(cursor, span.tagStart), textTag(xml, span, replacement), xmlText(replacement), span.closeTag);
      cursor = span.valueEnd;
    }
  }
  pieces.push(xml.slice(cursor));
  return pieces.join("");
}
