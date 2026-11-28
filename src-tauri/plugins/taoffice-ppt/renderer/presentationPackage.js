import { unzipSync, zipSync } from "fflate";
import { patchSlideText, slideParagraphs } from "./slideText.js";

export const MAX_PRESENTATION_BYTES = 24 * 1024 * 1024;
const MAX_COPY_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 96 * 1024 * 1024;
const MAX_PARTS = 4096;
const MAX_SLIDES = 300;
const MAX_XML_BYTES = 8 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const PRES_KIND = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const PRESENTATION_NS = new Set([
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
]);
const DOC_RELATIONSHIPS = [
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
];

function archive(parts, level) {
  return zipSync(parts, { level });
}

function invalidPackage() {
  return new Error("Open a valid PowerPoint PPTX package.");
}

function loadParts(bytes) {
  if (bytes.length < 22) throw invalidPackage();
  if (bytes.length > MAX_PRESENTATION_BYTES) throw new Error("PowerPoint preview is limited to 24 MiB.");
  let expanded = 0;
  const names = new Set();
  return unzipSync(bytes, {
    filter(part) {
      const path = part.name.replace(/\/$/u, "");
      if (/[:\\\u0000-\u001f]/u.test(path) || path.split("/").some((segment) => !segment
        || [".", "..", "__proto__", "constructor", "prototype"].includes(segment))) throw invalidPackage();
      if (names.has(path)) throw invalidPackage();
      names.add(path);
      expanded += part.originalSize;
      if (expanded > MAX_EXPANDED_BYTES || names.size > MAX_PARTS
        || (part.compression === 0 && part.size !== part.originalSize)
        || (/\.(?:xml|rels)$/iu.test(path) && part.originalSize > MAX_XML_BYTES)) {
        throw new Error("The unpacked presentation exceeds the preview limits.");
      }
      return !part.name.endsWith("/");
    },
  });
}

function parseXml(bytes, root, namespaces) {
  if (!bytes?.length || bytes.length > MAX_XML_BYTES) throw invalidPackage();
  const xml = decoder.decode(bytes);
  if (/<!DOCTYPE/iu.test(xml)) throw new Error("Presentation XML cannot declare a document type.");
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const element = document.documentElement;
  if (element?.localName !== root || !namespaces.includes(element.namespaceURI)) throw invalidPackage();
  return element;
}

function relationships(parts, file) {
  return parseXml(parts[file], "Relationships", [RELATIONSHIPS]);
}

function targetPath(base, relative, mode) {
  if (!relative || (mode && mode !== "Internal") || /[:?\\%\u0000-\u0020]/u.test(relative) || relative.startsWith("//")) return null;
  const root = relative.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const segment of relative.replace(/^\//u, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!root.length) return null;
      root.pop();
    } else {
      root.push(segment);
    }
  }
  return root.join("/") || null;
}

function relationshipPart(path) {
  const index = path.lastIndexOf("/") + 1;
  return path.slice(0, index) + "_rels/" + path.slice(index) + ".rels";
}

function relationshipOwner(path) {
  return path.replace(/(?:^|\/)_rels\/([^/]+)\.rels$/u, "/$1").replace(/^\//u, "");
}

function checkedRelationships(root) {
  const result = new Map();
  for (const link of root.children) {
    if (link.namespaceURI !== RELATIONSHIPS || link.localName !== "Relationship") throw invalidPackage();
    const id = link.getAttribute("Id");
    if (!id || result.has(id)) throw invalidPackage();
    result.set(id, link);
  }
  return result;
}

function internalTarget(owner, link, type) {
  if (!link || !DOC_RELATIONSHIPS.some((namespace) => link.getAttribute("Type") === namespace + "/" + type)) return null;
  return targetPath(owner, link.getAttribute("Target"), link.getAttribute("TargetMode"));
}

function presentationSlides(parts, file, root) {
  const namespace = root.namespaceURI;
  const list = Array.from(root.children).find((element) => element.namespaceURI === namespace && element.localName === "sldIdLst");
  const ids = Array.from(list?.children ?? [], (element) => {
    if (element.namespaceURI !== namespace || element.localName !== "sldId") throw invalidPackage();
    return DOC_RELATIONSHIPS.map((ns) => element.getAttributeNS(ns, "id")).find(Boolean);
  });
  if (!ids.length || ids.length > MAX_SLIDES) throw new Error("PowerPoint preview supports presentations with 1–300 slides.");
  if (new Set(ids).size !== ids.length || ids.some((id) => !id)) throw invalidPackage();
  const seen = new Set();
  const links = checkedRelationships(relationships(parts, relationshipPart(file)));
  return ids.map((id, index) => {
    const path = internalTarget(file, links.get(id), "slide");
    if (!path || !parts[path]?.length || seen.has(path)) throw invalidPackage();
    seen.add(path);
    const xml = decoder.decode(parts[path]);
    const { paragraphs, visible } = slideParagraphs(xml);
    return { path, xml, visible, paragraphs: paragraphs.map((paragraph) => ({ ...paragraph, id: index + "/" + paragraph.index })) };
  });
}

export function openPresentation(bytes) {
  const parts = loadParts(bytes);
  const contentTypes = parseXml(parts["[Content_Types].xml"], "Types", [CONTENT_TYPES]);
  const rootLinks = checkedRelationships(relationships(parts, "_rels/.rels"));
  const file = [...rootLinks.values()].map((link) => internalTarget("", link, "officeDocument")).find(Boolean);
  const type = Array.from(contentTypes.children).find((element) => element.namespaceURI === CONTENT_TYPES
    && element.localName === "Override" && element.getAttribute("PartName") === "/" + file)?.getAttribute("ContentType");
  if (!file || type !== PRES_KIND) throw invalidPackage();
  const root = parseXml(parts[file], "presentation", [...PRESENTATION_NS]);
  const slides = presentationSlides(parts, file, root);
  const hasSignature = Object.keys(parts).some((name) => name.toLowerCase().startsWith("_xmlsignatures/"))
    || Array.from(contentTypes.children).some((node) => (node.getAttribute("ContentType") ?? "").includes("digital-signature"));
  const protectedPresentation = Array.from(root.children).some((node) => node.localName === "modifyVerifier");
  const size = Array.from(root.children).find((node) => node.namespaceURI === root.namespaceURI && node.localName === "sldSz");
  const width = Number(size?.getAttribute("cx"));
  const height = Number(size?.getAttribute("cy"));
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  if (!Number.isFinite(aspect) || aspect > 8 || aspect < 1 / 8) throw invalidPackage();
  return {
    bytes, parts, slides,
    width: Math.round(1440 * Math.min(1, aspect)),
    height: Math.round(1440 / Math.max(1, aspect)),
    editable: !hasSignature && !protectedPresentation,
  };
}

function changedParts(presentation, edits) {
  const parts = { ...presentation.parts };
  for (const slide of presentation.slides) {
    const xml = patchSlideText(slide.xml, slide.paragraphs, edits);
    if (xml !== slide.xml) parts[slide.path] = encoder.encode(xml);
  }
  return parts;
}

export function presentationPreviewBytes(presentation, edits) {
  const parts = changedParts(presentation, edits);
  for (const file of Object.keys(parts)) {
    if (!file.toLowerCase().endsWith(".rels")) continue;
    const root = relationships(parts, file);
    let changed = false;
    for (const link of checkedRelationships(root).values()) {
      const safe = targetPath(relationshipOwner(file), link.getAttribute("Target"), link.getAttribute("TargetMode"));
      if (safe) continue;
      link.remove();
      changed = true;
    }
    if (changed) parts[file] = encoder.encode(new XMLSerializer().serializeToString(root));
  }
  return archive(parts, 0);
}

export function savePresentationCopy(presentation, edits) {
  if (!edits.size) return presentation.bytes;
  if (!presentation.editable) throw new Error("This presentation is read-only.");
  const output = archive(changedParts(presentation, edits), 6);
  if (output.length > MAX_COPY_BYTES) throw new Error("The presentation copy exceeds 32 MiB.");
  return output;
}
