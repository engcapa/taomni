// Shared jsdom stand-ins for screenshot overlay tests: decodable images whose
// natural size follows a `base64,<w>x<h>` data URL, and a 2D canvas context
// that records calls without rendering.

import { vi } from "vitest";

export function installOverlayImageStub(): void {
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img");
    image.decode = vi.fn().mockResolvedValue(undefined);
    let width = 2048, height = 1152;
    Object.defineProperties(image, {
      naturalWidth: { get: () => width }, naturalHeight: { get: () => height },
      src: { set: (url: string) => {
        const size = /base64,(\d+)x(\d+)$/.exec(url);
        if (size) { width = Number(size[1]); height = Number(size[2]); }
        queueMicrotask(() => image.onload?.(new Event("load")));
      } },
    });
    return image;
  });
}

export function installOverlayCanvasStub(): void {
  const context = new Proxy({} as CanvasRenderingContext2D, {
    get: (target, name) => {
      if (name === "getTransform") return () => ({ a: 1 });
      if (name === "getImageData") return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (!Reflect.has(target, name)) Reflect.set(target, name, vi.fn());
      return Reflect.get(target, name);
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
    return `data:image/png;base64,${this.width}x${this.height}`;
  });
}
