import { SaxesParser } from "saxes";

const WORD_NS = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
export const MAX_PARAGRAPH_LENGTH = 4096;

const isWord = (tag, name) => WORD_NS.has(tag?.uri) && tag.local === name;

export function editableParagraphs(xml) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const paragraphs = [];
  let body = false;
  let paragraph;
  parser.on("doctype", () => { throw new Error("DOCX XML declarations must not contain a document type."); });
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    stack.push(tag);
    if (stack.length > 128) throw new Error("The Word document is nested too deeply.");
    if (stack.length === 2 && isWord(stack[0], "document") && isWord(tag, "body")) body = true;
    if (stack.length === 3 && isWord(parent, "body") && isWord(tag, "p")) {
      paragraph = { id: paragraphs.length, runs: 0, texts: 0, supported: true, text: "" };
      return;
    }
    if (!paragraph || stack.length < 4) return;
    if (stack.slice(3, -1).some((ancestor) => isWord(ancestor, "pPr") || isWord(ancestor, "rPr"))) return;
    if (stack.length === 4 && isWord(tag, "r")) {
      paragraph.runs++;
    } else if ((stack.length === 4 && isWord(tag, "pPr")) || (isWord(parent, "r") && isWord(tag, "rPr"))) {
      // The paragraph and run properties stay in the original XML.
    } else if (stack.length === 5 && isWord(parent, "r") && isWord(tag, "t") && !tag.isSelfClosing) {
      paragraph.texts++;
      paragraph.valueStart = parser.position;
      paragraph.tagStart = xml.lastIndexOf("<", parser.position - 1);
      paragraph.addSpace = !Object.hasOwn(tag.attributes, "xml:space");
    } else {
      paragraph.supported = false;
    }
  });
  parser.on("text", (text) => {
    if (paragraph && stack.length === 5 && isWord(stack.at(-1), "t")) paragraph.text += text;
  });
  parser.on("cdata", () => { if (paragraph) paragraph.supported = false; });
  parser.on("closetag", (tag) => {
    if (paragraph && stack.length === 5 && isWord(tag, "t")) {
      paragraph.valueEnd = xml.lastIndexOf("</", parser.position - 1);
    }
    if (paragraph && stack.length === 3 && isWord(tag, "p")) {
      if (paragraph.supported && paragraph.runs === 1 && paragraph.texts === 1
        && paragraph.text.trim() && paragraph.text.length <= MAX_PARAGRAPH_LENGTH) {
        paragraphs.push(paragraph);
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

export function patchParagraphs(xml, paragraphs, edits) {
  let cursor = 0;
  const pieces = [];
  for (const paragraph of paragraphs) {
    if (!edits.has(paragraph.id)) continue;
    const value = edits.get(paragraph.id);
    if (typeof value !== "string" || value.length > MAX_PARAGRAPH_LENGTH
      || /[\u0000-\u001f\uFFFE\uFFFF\p{Cs}]/u.test(value)) {
      throw new Error("Use one line of text with up to 4096 characters per paragraph.");
    }
    if (value === paragraph.text) continue;
    pieces.push(xml.slice(cursor, paragraph.tagStart));
    const startTag = xml.slice(paragraph.tagStart, paragraph.valueStart);
    if (value !== value.trim()) {
      pieces.push(paragraph.addSpace
        ? startTag.slice(0, -1) + ' xml:space="preserve">'
        : startTag.replace(/\bxml:space\s*=\s*(["'])[^"']*\1/u, 'xml:space="preserve"'));
    } else {
      pieces.push(startTag);
    }
    pieces.push(xmlText(value));
    cursor = paragraph.valueEnd;
  }
  pieces.push(xml.slice(cursor));
  return pieces.join("");
}
