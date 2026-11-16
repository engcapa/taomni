import DOMPurify from "dompurify";

/** Office's SVG renderer supports presentation attributes more consistently
 * than Mermaid's scoped CSS, inherited fonts and relative tspan coordinates. */
export async function portableWordSvg(svg: Element, width: number, height: number, dark: boolean): Promise<string> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none";
  const shadow = host.attachShadow({ mode: "open" });
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(width)); copy.setAttribute("height", String(height));
  copy.style.maxWidth = "none"; copy.style.width = `${width}px`; copy.style.height = `${height}px`;
  shadow.append(copy); document.body.append(host);
  try {
    await document.fonts?.ready;
    const properties = ["font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline",
      "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
      "stroke-dasharray", "opacity", "color", "visibility", "letter-spacing", "text-decoration"];
    // Read the complete cascade before modifying any ancestor's styles.
    const nodes = [copy, ...copy.querySelectorAll<SVGElement>("*")].filter((node) => node.tagName.toLowerCase() !== "style");
    const styles = nodes.map((node) => {
      const computed = getComputedStyle(node);
      return properties.map((property) => [property, computed.getPropertyValue(property)] as const);
    });
    nodes.forEach((node, index) => {
      node.removeAttribute("style");
      for (const [property, value] of styles[index]) if (value) node.setAttribute(property, value);
      const fontSize = Number.parseFloat(node.getAttribute("font-size") || "16");
      if (["text", "tspan"].includes(node.tagName.toLowerCase())) {
        for (const name of ["x", "y", "dx", "dy"]) {
          const value = node.getAttribute(name);
          if (value && /^-?(?:\d*\.)?\d+em$/.test(value)) node.setAttribute(name, String(Number.parseFloat(value) * fontSize));
        }
      }
    });
    // Mermaid sequence actors share the rectangle's class on <text>. The
    // actual label paint lives on its tspan. Office/LibreOffice can apply the
    // parent paint to the entire text run, producing a pale fill and blue
    // outlined glyphs. Give the text owner the effective label paint as well.
    copy.querySelectorAll("text").forEach((text) => {
      const label = Array.from(text.querySelectorAll("tspan")).find((span) => span.textContent?.trim());
      if (!label) return;
      for (const property of ["fill", "stroke", "stroke-width", "fill-opacity", "stroke-opacity"]) {
        const value = label.getAttribute(property);
        if (value) text.setAttribute(property, value);
      }
    });
    copy.querySelectorAll("style").forEach((node) => node.remove());
    const box = copy.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
    const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    background.setAttribute("x", String(box?.[0] || 0)); background.setAttribute("y", String(box?.[1] || 0));
    background.setAttribute("width", String(width)); background.setAttribute("height", String(height));
    background.setAttribute("fill", dark ? "#191c22" : "#ffffff");
    copy.prepend(background);
    return new XMLSerializer().serializeToString(copy);
  } finally { host.remove(); }
}

export function embeddedSvg(node: Element): Element | undefined {
  if (node.tagName.toLowerCase() === "svg") return node;
  const source = node.getAttribute("src") || "";
  const match = /^data:image\/svg\+xml([^,]*),([\s\S]*)$/i.exec(source);
  if (!match) return undefined;
  const text = /;base64/i.test(match[1]) ? new TextDecoder().decode(Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0))) : decodeURIComponent(match[2]);
  const clean = DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true } });
  const svg = new DOMParser().parseFromString(clean, "image/svg+xml").documentElement;
  if (svg.tagName.toLowerCase() !== "svg") throw new Error("Cannot decode the SVG image");
  return svg;
}
