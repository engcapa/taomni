import { unzipSync, zipSync } from "fflate";
import { editableParagraphs, patchParagraphs } from "./wordXml.js";

export const MAX_DOCX_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_PARTS = 2048;
const DOCX_DOCUMENT = "word/document.xml";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export function openDocx(bytes) {
  if (bytes.length > MAX_DOCX_BYTES) throw new Error("DOCX preview is limited to 16 MiB.");
  if (bytes.length < 22) throw new Error("Open a valid Word DOCX package.");
  const names = new Set();
  let expanded = 0;
  const parts = unzipSync(bytes, {
    filter(part) {
      const path = part.name.replace(/\/$/, "");
      if (/[:\\\u0000]/u.test(path) || path.split("/").some((segment) => !segment
        || [".", "..", "__proto__", "constructor", "prototype"].includes(segment))) {
        throw new Error("Invalid path in the DOCX package.");
      }
      if (names.has(path)) throw new Error("Duplicate path in the DOCX package.");
      names.add(path);
      expanded += part.originalSize;
      if (expanded > MAX_EXPANDED_BYTES || names.size > MAX_PARTS
        || (part.compression === 0 && part.size !== part.originalSize)) {
        throw new Error("The unpacked DOCX exceeds the preview limits.");
      }
      return !part.name.endsWith("/");
    },
  });
  if (!parts[DOCX_DOCUMENT] || !parts["[Content_Types].xml"]) {
    throw new Error("Open a valid Word DOCX package.");
  }
  for (const [name, part] of Object.entries(parts)) {
    if (!/\.(?:xml|rels)$/i.test(name)) continue;
    if (part.length > MAX_XML_BYTES || /<!DOCTYPE/i.test(decoder.decode(part))) {
      throw new Error("The DOCX contains an unsupported XML part.");
    }
  }
  const xml = decoder.decode(parts[DOCX_DOCUMENT]);
  const paragraphs = editableParagraphs(xml);
  const protection = parts["word/settings.xml"] && /<[\w.-]*:?documentProtection\b/.test(decoder.decode(parts["word/settings.xml"]));
  const signed = [...names].some((name) => name.startsWith("_xmlsignatures/"));
  return { bytes, parts, xml, paragraphs: protection || signed ? [] : paragraphs };
}

export function docxPreviewBytes(docx, edits) {
  const xml = patchParagraphs(docx.xml, docx.paragraphs, edits);
  return zipSync({ ...docx.parts, [DOCX_DOCUMENT]: encoder.encode(xml) }, { level: 0 });
}

export function saveDocxCopy(docx, edits) {
  const xml = patchParagraphs(docx.xml, docx.paragraphs, edits);
  if (xml === docx.xml) return docx.bytes;
  const output = zipSync({ ...docx.parts, [DOCX_DOCUMENT]: encoder.encode(xml) });
  if (output.length > MAX_DOCX_BYTES) throw new Error("The edited DOCX exceeds 16 MiB.");
  return output;
}
