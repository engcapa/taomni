import { diagramBounds, type DiagramTransform, type ImageSnapshot } from "./diagramModel";

export async function markdownImagePng(snapshot: ImageSnapshot, transform: DiagramTransform): Promise<Blob> {
  const { width, height } = diagramBounds(snapshot.width, snapshot.height, transform.rotation);
  if (width * height > 40_000_000 || width > 32_700 || height > 32_700) {
    throw new Error("This image is too large to save as PNG");
  }
  const image = new Image();
  image.src = snapshot.src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable");
    context.translate(width / 2, height / 2);
    context.rotate(transform.rotation * Math.PI / 180);
    context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
    context.drawImage(image, -snapshot.width / 2, -snapshot.height / 2);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png");
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
