import { PDFHexString, PDFName } from "@cantoo/pdf-lib";

export const PDF_MARKUP_TOOLS = ["highlight", "box", "ink", "note"];
const STROKE = {
  highlight: [1, 0.78, 0.19], box: [0.12, 0.42, 0.8],
  ink: [0.13, 0.32, 0.71], note: [0.91, 0.65, 0.17],
};

export function markupBounds(points, padding = 0) {
  return [
    Math.min(...points.map(([x]) => x)) - padding,
    Math.min(...points.map(([, y]) => y)) - padding,
    Math.max(...points.map(([x]) => x)) + padding,
    Math.max(...points.map(([, y]) => y)) + padding,
  ];
}

function number(value) {
  if (!Number.isFinite(value)) throw new Error("An annotation has invalid coordinates.");
  return Number(value.toFixed(3));
}

function markupShape(kind, points) {
  const bounds = markupBounds(points, kind === "ink" || kind === "box" ? 2 : 0);
  if (kind === "note") {
    const [[x, y]] = points;
    return { rect: [x, y - 16, x + 16, y], draw: "0.75 0.75 14.5 14.5 re S", subtype: "Text" };
  }
  const [left, bottom, right, top] = bounds;
  const width = right - left;
  const height = top - bottom;
  if (kind === "highlight") {
    return { rect: bounds, subtype: "Highlight", draw: `/Fade gs 0 0 ${number(width)} ${number(height)} re f`,
      quad: [left, top, right, top, left, bottom, right, bottom] };
  }
  if (kind === "box") {
    return { rect: bounds, subtype: "Square",
      draw: `1.5 w 2 2 ${number(width - 4)} ${number(height - 4)} re S` };
  }
  return {
    rect: bounds, subtype: "Ink", ink: [points.flat()],
    draw: "1.75 w 1 J 1 j " + points.map(([x, y], index) =>
      `${number(x - left)} ${number(y - bottom)} ${index === 0 ? "m" : "l"}`).join(" ") + " S",
  };
}

export function appendPdfMarkup(pdf, page, { kind, points, text }) {
  if (!PDF_MARKUP_TOOLS.includes(kind) || !points.length || points.length > 512 ||
    (kind === "note" ? !text?.trim() || text.length > 1000 : points.length < 2)) {
    throw new Error("The PDF annotation is incomplete.");
  }
  const shape = markupShape(kind, points);
  const [x1, y1, x2, y2] = shape.rect.map(number);
  if (x2 <= x1 || y2 <= y1) throw new Error("The PDF annotation has no area.");
  const { context } = pdf;
  const color = STROKE[kind];
  const channels = color.join(" ");
  const appearance = context.register(context.flateStream(`q ${channels} RG ${channels} rg ${shape.draw} Q`, {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, x2 - x1, y2 - y1],
    Resources: kind === "highlight" ? { ExtGState: { Fade: { Type: "ExtGState", ca: 0.32, BM: "Multiply" } } } : {},
  }));
  const annotation = context.obj({
    Type: "Annot", Subtype: shape.subtype, Rect: [x1, y1, x2, y2], P: page.ref,
    C: color, F: 4, AP: { N: appearance },
  });
  if (shape.quad) annotation.set(PDFName.of("QuadPoints"), context.obj(shape.quad));
  if (shape.ink) annotation.set(PDFName.of("InkList"), context.obj(shape.ink));
  if (text) annotation.set(PDFName.of("Contents"), PDFHexString.fromText(text));
  if (kind === "note") annotation.set(PDFName.of("Name"), PDFName.of("Comment"));
  page.node.addAnnot(context.register(annotation));
}
