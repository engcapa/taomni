import DOMPurify from "dompurify";

const LABEL_TAGS = ["b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "font", "span", "div", "p", "br", "pre", "h1", "h2", "h3", "h4", "ul", "ol", "li", "table", "tbody", "tr", "td", "th"];
const LABEL_STYLES = ["color", "background-color", "font-family", "font-size", "font-style", "font-weight", "line-height", "text-align", "text-decoration", "vertical-align", "white-space", "padding", "margin"];

export function safeDrawioLabel(value: string): string {
  const content = DOMPurify.sanitize(value, { ALLOWED_TAGS: LABEL_TAGS, ALLOWED_ATTR: ["style", "color", "face", "size", "align", "colspan", "rowspan"], ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true });
  content.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const safe = LABEL_STYLES.flatMap((property) => {
      const value = element.style.getPropertyValue(property);
      return value && !/[\\@]|(?:url|image|expression|var)\s*\(/i.test(value) ? [`${property}:${value}`] : [];
    });
    element.style.cssText = safe.join(";");
  });
  const template = document.createElement("template");
  template.content.append(content);
  return template.innerHTML;
}

export function safeDrawioSvg(markup: string): SVGSVGElement {
  const parser = new DOMParser();
  const source = parser.parseFromString(markup, "image/svg+xml");
  const namespace = "http://www.w3.org/2000/svg";
  const labels = Array.from(source.querySelectorAll("foreignObject"));
  labels.forEach((label, index) => {
    const slot = source.createElementNS(namespace, "g");
    slot.setAttribute("data-drawio-label", String(index));
    label.replaceWith(slot);
  });
  const clean = DOMPurify.sanitize(new XMLSerializer().serializeToString(source), {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["switch"],
    FORBID_TAGS: ["style", "a", "feImage", "animate", "animateMotion", "animateTransform", "set"],
  });
  const svg = parser.parseFromString(clean, "image/svg+xml").documentElement;
  if (svg.localName !== "svg") throw new Error("Invalid draw.io SVG");
  svg.querySelectorAll("[data-drawio-label]").forEach((slot) => {
    const original = labels[Number(slot.getAttribute("data-drawio-label"))];
    if (!original) { slot.remove(); return; }
    const label = svg.ownerDocument.createElementNS(namespace, "foreignObject");
    for (const name of ["x", "y", "width", "height", "style", "pointer-events", "requiredFeatures"]) {
      const value = original.getAttribute(name);
      if (value !== null) label.setAttribute(name, value);
    }
    const content = DOMPurify.sanitize(original.innerHTML, {
      ALLOWED_TAGS: LABEL_TAGS, ALLOWED_ATTR: ["style", "color", "face", "size", "align", "colspan", "rowspan"],
      ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true,
    });
    label.append(content);
    slot.replaceWith(label);
  });
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    for (const attr of Array.from(node.attributes)) {
      if (["href", "xlink:href"].includes(attr.name) && !/^#|^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml)[;,]/i.test(attr.value)) node.removeAttribute(attr.name);
      if (attr.name === "style" && /\\|@|(?:url|expression|image-set)\s*\(/i.test(attr.value)) node.removeAttribute(attr.name);
      if (attr.name !== "style" && /url\(/i.test(attr.value) && !/^url\(#[\w.:-]+\)$/i.test(attr.value)) node.removeAttribute(attr.name);
    }
  }
  return svg as unknown as SVGSVGElement;
}
