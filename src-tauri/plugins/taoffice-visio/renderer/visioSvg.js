const svgNamespace = "http://www.w3.org/2000/svg";
const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
const xmlnsNamespace = "http://www.w3.org/2000/xmlns/";
const linkNamespace = "http://www.w3.org/1999/xlink";
const elements = new Set([
  "svg", "g", "defs", "title", "desc", "path", "rect", "circle", "ellipse", "polygon", "polyline", "line",
  "text", "tspan", "image", "marker", "pattern", "use", "clipPath", "mask",
  "linearGradient", "radialGradient", "stop",
  "filter", "feOffset", "feColorMatrix", "feMerge", "feMergeNode", "feGaussianBlur", "feBlend",
]);
const properties = new Set([
  "color", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray",
  "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "filter", "mask",
  "marker-start", "marker-mid", "marker-end", "clip-path", "clip-rule", "stop-color", "stop-opacity",
  "text-anchor", "font-family", "font-style", "font-weight", "font-size", "font-variant", "font-stretch",
  "text-decoration", "letter-spacing", "word-spacing", "dominant-baseline", "alignment-baseline", "baseline-shift",
  "direction", "writing-mode", "unicode-bidi", "visibility", "display", "white-space",
]);
const geometry = new Set([
  "id", "version", "viewBox", "preserveAspectRatio", "transform", "x", "y", "x1", "y1", "x2", "y2",
  "rx", "ry", "cx", "cy", "fx", "fy", "r", "width", "height", "points", "d", "dx", "dy", "rotate",
  "textLength", "lengthAdjust", "offset", "gradientUnits", "gradientTransform", "spreadMethod",
  "patternUnits", "patternContentUnits", "patternTransform", "markerUnits", "markerWidth", "markerHeight",
  "refX", "refY", "orient", "clipPathUnits", "maskUnits", "maskContentUnits", "filterUnits",
  "primitiveUnits", "in", "in2", "result", "type", "values", "stdDeviation", "mode",
]);
const fragment = /^#[\w:.-]+$/;
const bitmap = /^data:image\/(?:png|jpeg|gif|webp|bmp|tiff);base64,[0-9a-z+/=\s]+$/i;

function presentationValue(value) {
  return /^url\(#[\w:.-]+\)$/i.test(value)
    || (!/url|expression|image-set|[\\@{};<>]/i.test(value) && value.length <= 2048);
}

function presentationStyle(value) {
  return value.split(";").flatMap((part) => {
    const separator = part.indexOf(":");
    if (separator < 0) return [];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    return properties.has(name) && presentationValue(value) ? [`${name}: ${value}`] : [];
  }).join("; ");
}

function cleanAttributes(element) {
  for (const attr of [...element.attributes]) {
    const { namespaceURI, localName: name, value } = attr;
    if ((!namespaceURI || namespaceURI === linkNamespace) && name === "href") {
      if (element.localName === "image" ? bitmap.test(value)
        : ["use", "linearGradient", "radialGradient", "pattern"].includes(element.localName) && fragment.test(value)) continue;
    }
    if (namespaceURI === xmlnsNamespace && [svgNamespace, linkNamespace].includes(value)) continue;
    if (namespaceURI === xmlNamespace && name === "space" && ["preserve", "default"].includes(value)) continue;
    if (!namespaceURI && name === "style") {
      const style = presentationStyle(value);
      if (style) {
        attr.value = style;
        continue;
      }
    }
    if (!namespaceURI && (geometry.has(name) || (properties.has(name) && presentationValue(value.trim())))) continue;
    element.removeAttributeNode(attr);
  }
}

function dimensions(svg) {
  const viewBox = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const [, , width, height] = viewBox ?? [];
  if (viewBox?.length !== 4 || !viewBox.every(Number.isFinite)
    || width <= 0 || height <= 0 || width > 144_000 || height > 144_000) throw new Error("format");
  return { width: width * 4 / 3, height: height * 4 / 3 };
}

export function normalizeSearch(value) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function preparePage(page) {
  if (/<!(?:DOCTYPE|ENTITY)/i.test(page.svg)) throw new Error("format");
  const document = new DOMParser().parseFromString(page.svg, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== svgNamespace
    || document.getElementsByTagName("parsererror").length) throw new Error("format");
  for (const element of [root, ...root.getElementsByTagName("*")]) {
    if (element.namespaceURI !== svgNamespace || !elements.has(element.localName)) element.remove();
    else cleanAttributes(element);
  }
  const size = dimensions(root);
  root.setAttribute("width", String(size.width));
  root.setAttribute("height", String(size.height));
  const text = normalizeSearch([...root.querySelectorAll("text")].map((item) => item.textContent).join(" "));
  return {
    name: page.name,
    ...size,
    text,
    svg: new XMLSerializer().serializeToString(root),
  };
}
