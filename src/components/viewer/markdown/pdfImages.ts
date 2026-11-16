interface PdfImage {
  image: HTMLImageElement;
  radius: number;
  opacity: number;
}

/** WebKit can omit raster <img> resources inside the SVG foreignObject used
 * by DOM capture. Decode normally, preserve layout, then paint these resources
 * directly on the page canvas inside the same content clip. */
export function preparePdfImages(root: HTMLElement): PdfImage[] {
  return Array.from(root.querySelectorAll("img")).flatMap((image) => {
    const style = getComputedStyle(image);
    if (style.visibility === "hidden" || style.display === "none") return [];
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Cannot decode an exported PDF image");
    const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
    let opacity = 1;
    for (let node: HTMLElement | null = image; node && root.contains(node); node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity || 1);
    image.style.visibility = "hidden";
    return [{ image, radius, opacity }];
  });
}

export function paintPdfImages(images: PdfImage[], canvas: HTMLCanvasElement, page: HTMLElement, viewport: HTMLElement): void {
  const bounds = page.getBoundingClientRect(), clip = viewport.getBoundingClientRect();
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PDF image rendering is unavailable");
  context.save();
  try {
    context.scale(canvas.width / bounds.width, canvas.height / bounds.height);
    context.beginPath(); context.rect(clip.left - bounds.left, clip.top - bounds.top, clip.width, clip.height); context.clip();
    for (const { image, radius, opacity } of images) {
      const box = image.getBoundingClientRect();
      if (!box.width || !box.height || box.bottom <= clip.top || box.top >= clip.bottom || box.right <= clip.left || box.left >= clip.right) continue;
      const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
      const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
      const x = box.left - bounds.left + (box.width - width) / 2, y = box.top - bounds.top + (box.height - height) / 2;
      context.save();
      try {
        context.globalAlpha = opacity;
        context.beginPath(); context.roundRect(x, y, width, height, radius); context.clip();
        context.drawImage(image, x, y, width, height);
      } finally { context.restore(); }
    }
  } finally { context.restore(); }
}
