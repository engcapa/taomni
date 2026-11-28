import { unzipSync, zipSync } from "fflate";

const VISIO = "http://schemas.microsoft.com/office/visio/2012/main";
const TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOCUMENT_RELS = "http://schemas.microsoft.com/visio/2010/relationships/";
const OFFICE_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAX_BYTES = 32 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
export const MAX_TEXT = 2048;
export const cellProperties = ["PinX", "PinY", "FillForegnd", "LineColor"];

export function validShapeEdits(edits) {
  return [...edits].every(([key, value]) => validShapeValue(key.split("\u0000").at(-1), value));
}

function invalid() {
  return new Error("This diagram cannot be edited safely.");
}

function children(node, name, namespace = VISIO) {
  return [...node.children].filter(child => child.namespaceURI === namespace && child.localName === name);
}

function xml(parts, path, name, namespace) {
  const bytes = parts[path];
  if (!bytes?.length || bytes.length > 8 * 1024 * 1024) throw invalid();
  const source = decoder.decode(bytes);
  if (/<!(?:DOCTYPE|ENTITY)/iu.test(source)) throw invalid();
  const root = new DOMParser().parseFromString(source, "application/xml").documentElement;
  if (root.localName !== name || root.namespaceURI !== namespace) throw invalid();
  return root;
}

function loadParts(input) {
  if (!input.length || input.length > MAX_BYTES) throw invalid();
  const entries = new Set();
  let size = 0;
  return unzipSync(input, { filter(part) {
    const path = part.name.replace(/\/$/u, "");
    if (!path || /[\\:\u0000-\u001f]/u.test(path)
      || path.split("/").some(segment => !segment || [".", "..", "__proto__", "constructor", "prototype"].includes(segment))
      || entries.has(path)) throw invalid();
    entries.add(path);
    size += part.originalSize;
    if (size > 96 * 1024 * 1024 || entries.size > 4096
      || (part.compression === 0 && part.size !== part.originalSize)) throw invalid();
    return !part.name.endsWith("/");
  } });
}

function links(parts, owner, kind) {
  const slash = owner.lastIndexOf("/") + 1;
  const dir = owner.slice(0, slash);
  const file = dir + "_rels/" + owner.slice(slash) + ".rels";
  const result = new Map();
  for (const link of children(xml(parts, file, "Relationships", RELS), "Relationship", RELS)) {
    if (link.getAttribute("Type") !== DOCUMENT_RELS + kind) continue;
    const id = link.getAttribute("Id");
    const target = link.getAttribute("Target") ?? "";
    if (!id || result.has(id) || !target || link.getAttribute("TargetMode") === "External"
      || /[\\?#:%\u0000-\u001f]/u.test(target) || target.startsWith("//")) throw invalid();
    const segments = target.startsWith("/") ? [] : dir.split("/").filter(Boolean);
    for (const segment of target.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (!segments.length) throw invalid();
        segments.pop();
      } else segments.push(segment);
    }
    result.set(id, segments.join("/"));
  }
  return result;
}

function only(links) {
  if (links.size !== 1) throw invalid();
  return links.values().next().value;
}

export function validShapeValue(field, value) {
  if (typeof value !== "string") return false;
  if (field === "Text") return value.length <= MAX_TEXT
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value);
  if (field === "PinX" || field === "PinY") return /^-?(?:\d+\.?\d*|\.\d+)$/u.test(value)
    && value.length <= 32 && Math.abs(Number(value)) <= 100000;
  return /^#[0-9a-f]{6}$/iu.test(value);
}

function simpleFields(shape) {
  if (shape.getAttribute("Type") !== "Shape" || ["Master", "MasterShape", "Del"].some(name => shape.hasAttribute(name))
    || [...shape.children].some(node => ["Shapes", "ForeignData"].includes(node.localName))) return [];
  const cells = children(shape, "Cell");
  if (cells.some(cell => /^(?:Lock|Protection)/u.test(cell.getAttribute("N"))
    && (cell.getAttribute("V") !== "0" || cell.hasAttribute("F")))) return [];
  const fields = [];
  const texts = children(shape, "Text");
  if (texts.length === 1 && !texts[0].children.length && validShapeValue("Text", texts[0].textContent)) {
    fields.push(["Text", texts[0].textContent, texts[0]]);
  }
  for (const name of cellProperties) {
    const matching = cells.filter(cell => cell.getAttribute("N") === name);
    if (matching.length === 1 && !matching[0].hasAttribute("F") && !matching[0].hasAttribute("Del")
      && validShapeValue(name, matching[0].getAttribute("V"))) {
      fields.push([name, matching[0].getAttribute("V"), matching[0]]);
    }
  }
  return fields;
}

function pageShapes(root) {
  const connected = new Set(children(root, "Connects").flatMap(list => children(list, "Connect"))
    .flatMap(link => [link.getAttribute("ToSheet"), link.getAttribute("FromSheet")]));
  const ids = new Set();
  const result = [];
  for (const list of children(root, "Shapes")) {
    for (const shape of children(list, "Shape")) {
      const id = shape.getAttribute("ID");
      if (!id || !/^\d+$/u.test(id) || ids.has(id)) throw invalid();
      ids.add(id);
      if (connected.has(id)) continue;
      const fields = simpleFields(shape);
      if (fields.length) result.push({ id, fields });
    }
  }
  return result;
}

export function editableVisio(bytes, rendered) {
  try {
    const parts = loadParts(bytes);
    const types = xml(parts, "[Content_Types].xml", "Types", TYPES);
    if (Object.keys(parts).some(name => /(?:^_xmlsignatures\/|vbaProject\.bin$)/iu.test(name))
      || [...types.children].some(type => /digital-signature|macroEnabled/iu.test(type.getAttribute("ContentType")))) return null;
    const document = only(links(parts, "", "document"));
    if (!children(types, "Override", TYPES).some(type => type.getAttribute("PartName") === "/" + document
      && type.getAttribute("ContentType") === "application/vnd.ms-visio.drawing.main+xml")) return null;
    const doc = xml(parts, document, "VisioDocument", VISIO);
    for (const settings of children(doc, "DocumentSettings")) {
      const protectedFlag = value => !["0", "false"].includes(value.trim().toLowerCase());
      if ([...settings.attributes].some(attr => /^Protect/u.test(attr.localName) && protectedFlag(attr.value))
        || [...settings.children].some(node => /^Protect/u.test(node.localName) && protectedFlag(node.textContent))) return null;
    }
    const index = only(links(parts, document, "pages"));
    const relations = links(parts, index, "page");
    const descriptors = children(xml(parts, index, "Pages", VISIO), "Page").filter(page => !["1", "true"].includes(page.getAttribute("Background")));
    if (descriptors.length !== rendered.length) return null;
    const paths = new Set();
    const pages = descriptors.map((page, number) => {
      const path = relations.get(children(page, "Rel")[0]?.getAttributeNS(OFFICE_RELS, "id"));
      if (!path || paths.has(path) || ![page.getAttribute("Name"), page.getAttribute("NameU")].includes(rendered[number].name)) throw invalid();
      paths.add(path);
      const shapes = pageShapes(xml(parts, path, "PageContents", VISIO)).map(({ id, fields }) => ({
        id, fields: Object.fromEntries(fields.map(([name, value]) => [name, value])),
      }));
      return { path, shapes };
    });
    return { bytes, parts, pages };
  } catch {
    // libvisio can render more document variants than the copy editor can write.
    return null;
  }
}

export function fieldKey(page, shape, field) {
  return [page.path, shape.id, field].join("\u0000");
}

export function saveVisioCopy(diagram, edits) {
  if (!edits.size) return diagram.bytes;
  const parts = { ...diagram.parts };
  let applied = 0;
  for (const page of diagram.pages) {
    if (!page.shapes.some(shape => Object.keys(shape.fields).some(name => edits.has(fieldKey(page, shape, name))))) continue;
    const root = xml(parts, page.path, "PageContents", VISIO);
    for (const shape of pageShapes(root)) {
      for (const [field, , node] of shape.fields) {
        const key = fieldKey(page, shape, field);
        if (!edits.has(key)) continue;
        const value = edits.get(key);
        if (!validShapeValue(field, value)) throw invalid();
        if (field === "Text") node.textContent = value;
        else node.setAttribute("V", value);
        applied++;
      }
    }
    parts[page.path] = encoder.encode(new XMLSerializer().serializeToString(root));
  }
  if (applied !== edits.size) throw invalid();
  const output = zipSync(parts, { level: 6 });
  if (output.length > MAX_BYTES) throw invalid();
  return output;
}

