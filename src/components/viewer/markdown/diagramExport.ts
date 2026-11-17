import { portableWordSvg } from "./wordSvg";
import { diagramBounds, normalizeRotation, type DiagramSnapshot, type DiagramTransform } from "./diagramModel";

const SVG_NS = "http://www.w3.org/2000/svg";
export const DIAGRAM_PNG_DPI = 300;
const MAX_PIXELS = 40_000_000;

/** Saved images contain the complete rotated/flipped diagram. Viewer pan/zoom
 * never crops output or changes the original Markdown/Mermaid definition. */
export async function diagramSvg(snapshot: DiagramSnapshot, transform: DiagramTransform): Promise<string> {
  const { width, height } = snapshot;
  const portable = await portableWordSvg(snapshot.svg, width, height, snapshot.theme === "dark");
  const rotation = normalizeRotation(transform.rotation);
  if (!rotation && !transform.flipX && !transform.flipY) return portable;
  const bounds = diagramBounds(width, height, rotation);
  const outer = document.createElementNS(SVG_NS, "svg");
  outer.setAttribute("xmlns", SVG_NS);
  outer.setAttribute("width", String(bounds.width)); outer.setAttribute("height", String(bounds.height));
  outer.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("transform", `translate(${bounds.width / 2} ${bounds.height / 2}) rotate(${rotation}) scale(${transform.flipX ? -1 : 1} ${transform.flipY ? -1 : 1}) translate(${-width / 2} ${-height / 2})`);
  const svg = new DOMParser().parseFromString(portable, "image/svg+xml").documentElement;
  svg.setAttribute("x", "0"); svg.setAttribute("y", "0");
  group.append(svg); outer.append(group);
  return new XMLSerializer().serializeToString(outer);
}

export async function diagramPng(snapshot: DiagramSnapshot, transform: DiagramTransform): Promise<Blob> {
  const bounds = diagramBounds(snapshot.width, snapshot.height, transform.rotation);
  const width = Math.ceil(bounds.width * DIAGRAM_PNG_DPI / 96), height = Math.ceil(bounds.height * DIAGRAM_PNG_DPI / 96);
  if (width * height > MAX_PIXELS || width > 32700 || height > 32700) throw new Error("This diagram is too large for a high-resolution PNG; save SVG instead");
  const url = URL.createObjectURL(new Blob([await diagramSvg(snapshot, transform)], { type: "image/svg+xml" }));
  const canvas = document.createElement("canvas");
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error("Cannot decode the Mermaid image")); image.src = url;
    });
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable");
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png"));
  } finally { URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0; }
}
