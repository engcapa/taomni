// The editor retains document order, including identical text in different cells.
// Only paragraphs approved by the package reader receive an editing control.
export function wordPageLayout(document) {
  const xml = new DOMParser().parseFromString(document.xml, "application/xml");
  const ns = xml.documentElement.namespaceURI;
  const wordChildren = node => Array.from(node.children).filter(item => item.namespaceURI === ns);
  const child = (node, name) => wordChildren(node).find(item => item.localName === name);
  const attr = (node, name) => node?.getAttributeNS(ns, name);
  const body = child(xml.documentElement, "body");
  const paragraphs = [...xml.getElementsByTagNameNS(ns, "p")];
  const editable = new Map(document.paragraphs.map(paragraph => [paragraphs[paragraph.index], paragraph]));

  function blocks(node) {
    return wordChildren(node).flatMap(item => {
      if (item.localName === "p") {
        const paragraph = editable.get(item);
        const properties = child(item, "pPr");
        const style = properties && attr(child(properties, "pStyle"), "val");
        const alignment = properties && attr(child(properties, "jc"), "val");
        const heading = /^(?:Title|Heading[1-6])$/i.test(style || "");
        const text = paragraph?.text ?? Array.from(item.getElementsByTagNameNS(ns, "t"), tag => tag.textContent).join("");
        return [{ kind: "paragraph", paragraph, text, heading,
          align: ["center", "left", "right", "start", "end"].includes(alignment) ? alignment : undefined }];
      }
      if (item.localName === "tbl") {
        const rows = wordChildren(item).filter(tag => tag.localName === "tr").map(row =>
          wordChildren(row).filter(tag => tag.localName === "tc").map(cell => {
            const props = child(cell, "tcPr");
            const span = props && Number(attr(child(props, "gridSpan"), "val"));
            return { span: Number.isInteger(span) && span > 0 && span <= 63 ? span : 1, blocks: blocks(cell) };
          }));
        return [{ kind: "table", rows }];
      }
      return [];
    });
  }
  if (!body) return { blocks: [], paper: {} };
  const section = child(body, "sectPr");
  const size = section && child(section, "pgSz");
  const margin = section && child(section, "pgMar");
  function inches(node, name, fallback, max) {
    const value = attr(node, name);
    const measurement = value && Number(value) / 1440;
    return Number.isFinite(measurement) && measurement >= 0 && measurement <= max
      ? measurement : fallback;
  }
  const width = inches(size, "w", 8.5, 22) || 8.5;
  const height = inches(size, "h", 11, 22) || 11;
  const paper = {
    width: width + "in", minHeight: height + "in",
    paddingTop: inches(margin, "top", 1, height / 2) + "in",
    paddingRight: inches(margin, "right", 1, width / 2) + "in",
    paddingBottom: inches(margin, "bottom", 1, height / 2) + "in",
    paddingLeft: inches(margin, "left", 1, width / 2) + "in",
  };
  return { blocks: blocks(body), paper };
}
