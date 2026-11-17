import { type MermaidApi } from "./types";

export let mermaidReady = false;

export let mermaidPromise: Promise<MermaidApi> | null = null;

export function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid")
    .then((mod) => mod.default)
    .catch((err) => {
      mermaidPromise = null;
      throw err;
    });
  return mermaidPromise;
}

export async function ensureMermaidReady(): Promise<MermaidApi> {
  const mermaid = await loadMermaid();
  if (mermaidReady) return mermaid;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "default",
  });
  mermaidReady = true;
  return mermaid;
}

export type MermaidTheme = "light" | "dark";
let renderQueue: Promise<unknown> = Promise.resolve();

/** Parsing also changes Mermaid's shared database; inspect it in the same
 * queue as rendering, before another document can replace that database. */
export function inspectMermaidDiagram<T>(source: string, inspect: (diagram: { type: string; db: unknown }) => T): Promise<T> {
  const job = renderQueue.catch(() => undefined).then(async () => {
    const mermaid = await ensureMermaidReady();
    return inspect(await mermaid.mermaidAPI.getDiagramFromText(source));
  });
  renderQueue = job;
  return job;
}

/** Mermaid has mutable module configuration. Own initialization and rendering
 * in one queue; another document/export must never change a render's theme. */
export function renderMermaid(id: string, source: string, theme: MermaidTheme = "light"): ReturnType<MermaidApi["render"]> {
  const job = renderQueue.catch(() => undefined).then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", htmlLabels: false,
      flowchart: { htmlLabels: false },
      themeVariables: theme === "dark" ? {
        darkMode: true, background: "#191c22", textColor: "#f1f5f9", lineColor: "#cbd5e1",
        primaryColor: "#24364f", primaryTextColor: "#f8fafc", primaryBorderColor: "#93c5fd",
        secondaryColor: "#3b3155", secondaryTextColor: "#f8fafc", secondaryBorderColor: "#c4b5fd",
        tertiaryColor: "#203e35", tertiaryTextColor: "#f8fafc", tertiaryBorderColor: "#86efac",
        clusterBkg: "#242934", clusterBorder: "#94a3b8", titleColor: "#f1f5f9",
        edgeLabelBackground: "#242934", actorBkg: "#24364f", actorBorder: "#93c5fd", actorTextColor: "#f8fafc",
        actorLineColor: "#cbd5e1", signalColor: "#e2e8f0", signalTextColor: "#f1f5f9",
        noteBkgColor: "#3b3155", noteBorderColor: "#c4b5fd", noteTextColor: "#f8fafc",
        labelBoxBkgColor: "#24364f", labelBoxBorderColor: "#93c5fd", labelTextColor: "#f8fafc",
      } : {
        darkMode: false, background: "#ffffff", textColor: "#1f2937", lineColor: "#475569",
        primaryColor: "#dbeafe", primaryTextColor: "#172554", primaryBorderColor: "#2563eb",
        secondaryColor: "#ede9fe", secondaryTextColor: "#2e1065", secondaryBorderColor: "#7c3aed",
        tertiaryColor: "#dcfce7", tertiaryTextColor: "#14532d", tertiaryBorderColor: "#15803d",
        clusterBkg: "#f6f8fa", clusterBorder: "#64748b", titleColor: "#1f2937",
        edgeLabelBackground: "#ffffff", actorBkg: "#dbeafe", actorBorder: "#2563eb", actorTextColor: "#172554",
        actorLineColor: "#475569", signalColor: "#334155", signalTextColor: "#1f2937",
        noteBkgColor: "#ede9fe", noteBorderColor: "#7c3aed", noteTextColor: "#2e1065",
      },
    });
    mermaidReady = true;
    // Keep labels as text: foreignObject cannot be embedded reliably into
    // Word or sanitized SVG. This directive affects only this rendered copy.
    return mermaid.render(id, `${source}\n%%{init: {"htmlLabels": false, "flowchart": {"htmlLabels": false}}}%%`);
  });
  renderQueue = job;
  return job;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportMermaidSvg(svg: SVGSVGElement, fileName: string): void {
  const text = new XMLSerializer().serializeToString(svg);
  downloadBlob(new Blob([text], { type: "image/svg+xml;charset=utf-8" }), fileName);
}

export function exportMermaidPng(svg: SVGSVGElement, fileName: string): void {
  const text = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const image = new Image();
  image.onload = () => {
    const box = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(box?.width || rect.width || image.width || 960));
    const height = Math.max(1, Math.ceil(box?.height || rect.height || image.height || 540));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      return;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    canvas.toBlob((blob) => {
      URL.revokeObjectURL(url);
      if (blob) downloadBlob(blob, fileName);
    }, "image/png");
  };
  image.onerror = () => URL.revokeObjectURL(url);
  image.src = url;
}
