import { deflateSync, Inflate, strFromU8, strToU8 } from "fflate";
import { readDrawioGraph } from "./drawioModel";

export interface DrawioPage { id: string; name: string; model: Element }
export const DRAWIO_MAX_BYTES = 20 * 1024 * 1024;
const MAX_CELLS = 10000;
const MAX_LINK_LENGTH = 1_500_000;
const serialize = (node: Node) => new XMLSerializer().serializeToString(node);

function xmlDocument(xml: string): Document {
  if (xml.length > DRAWIO_MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("draw.io XML exceeds limits or contains a document type");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid draw.io XML");
  return doc;
}

function decodeCompressed(data: string): string {
  if (data.length > DRAWIO_MAX_BYTES) throw new Error("draw.io data exceeds the 20 MB limit");
  const binary = atob(data.replace(/\s/g, ""));
  const chunks: Uint8Array[] = [];
  let size = 0;
  const decoder = new Inflate((chunk) => {
    size += chunk.length;
    if (size > DRAWIO_MAX_BYTES) throw new Error("Expanded draw.io data exceeds the 20 MB limit");
    chunks.push(chunk);
  });
  // Bound each inflate allocation before the callback can reject expansion.
  // Feeding an entire compressed file first defeats the output-size guard.
  const compressed = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  for (let offset = 0; offset < compressed.length; offset += 4096) decoder.push(compressed.subarray(offset, offset + 4096), offset + 4096 >= compressed.length);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return decodeURIComponent(strFromU8(output));
}

export function parseDrawio(input: string): DrawioPage[] {
  let xml = input.trim();
  if (/^https:\/\/app\.diagrams\.net\//i.test(xml)) {
    const hash = new URL(xml).hash;
    if (!hash.startsWith("#R")) throw new Error("This link does not contain an embedded draw.io document");
    xml = decodeCompressed(hash.slice(2));
  }
  const doc = xmlDocument(xml);
  const root = doc.documentElement;
  const pages = root.tagName === "mxGraphModel" ? [root] : root.tagName === "mxfile" ? Array.from(root.children) : [];
  if (!pages.length || pages.length > 100) throw new Error("draw.io must contain between 1 and 100 sheets");
  let cells = 0, expanded = 0;
  const ids = new Set<string>();
  return pages.map((page, index) => {
    if (page.tagName !== "diagram" && page.tagName !== "mxGraphModel") throw new Error("Unsupported draw.io page format");
    const model = page.tagName === "mxGraphModel" ? page : page.querySelector(":scope > mxGraphModel") ?? xmlDocument(decodeCompressed(page.textContent || "")).documentElement;
    expanded += serialize(model).length;
    cells += model.querySelectorAll("mxCell").length;
    if (cells > MAX_CELLS || expanded > DRAWIO_MAX_BYTES) throw new Error("draw.io document exceeds the safe import limit");
    readDrawioGraph(model);
    const id = page.getAttribute("id") || `sheet-${index + 1}`;
    if (ids.has(id)) throw new Error("draw.io contains duplicate sheet IDs");
    ids.add(id);
    return { id, name: page.getAttribute("name") || `Sheet ${index + 1}`, model: model.cloneNode(true) as Element };
  });
}

export function drawioFile(pages: DrawioPage[]): string {
  if (!pages.length) throw new Error("There is no content to export");
  const doc = document.implementation.createDocument("", "mxfile");
  doc.documentElement.setAttribute("host", "app.diagrams.net");
  doc.documentElement.setAttribute("agent", "Taomni");
  doc.documentElement.setAttribute("compressed", "false");
  for (const page of pages) {
    const diagram = doc.createElement("diagram");
    diagram.setAttribute("id", page.id); diagram.setAttribute("name", page.name);
    diagram.append(doc.importNode(page.model, true)); doc.documentElement.append(diagram);
  }
  const xml = serialize(doc);
  if (xml.length > DRAWIO_MAX_BYTES) throw new Error("draw.io export exceeds the 20 MB limit");
  return xml;
}

export function drawioLink(xml: string): string {
  const compressed = deflateSync(strToU8(encodeURIComponent(xml)));
  let binary = "";
  for (let offset = 0; offset < compressed.length; offset += 8192) binary += String.fromCharCode(...compressed.subarray(offset, offset + 8192));
  const link = `https://app.diagrams.net/?client=1#R${btoa(binary)}`;
  if (link.length > MAX_LINK_LENGTH) throw new Error("This document is too large for an online link; save a .drawio file instead");
  return link;
}

export function drawioElement(doc: Document, name: string, attributes: Record<string, string | number>): Element {
  const element = doc.createElement(name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

export function newDrawioPage(id: string, name: string): DrawioPage {
  const doc = document.implementation.createDocument("", "mxGraphModel");
  const model = doc.documentElement;
  for (const [key, value] of Object.entries({ adaptiveColors: "auto", page: "1", pageWidth: "1100", pageHeight: "850" })) model.setAttribute(key, value);
  const root = doc.createElement("root");
  root.append(drawioElement(doc, "mxCell", { id: "0" }), drawioElement(doc, "mxCell", { id: "1", parent: "0" }));
  model.append(root);
  return { id, name, model };
}

export function drawioCell(page: DrawioPage, attributes: Record<string, string | number>, geometry: Record<string, string | number>): Element {
  const doc = page.model.ownerDocument;
  const cell = drawioElement(doc, "mxCell", { parent: "1", ...attributes });
  cell.append(drawioElement(doc, "mxGeometry", { ...geometry, as: "geometry" }));
  page.model.querySelector("root")!.append(cell);
  return cell;
}
