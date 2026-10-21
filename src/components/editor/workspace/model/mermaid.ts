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
