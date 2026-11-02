import { useLayoutEffect, useRef } from "react";

/**
 * Mount the bitmap that was actually decoded, rather than creating a second
 * <img> with the same URL. WebKit can commit that new element before its bitmap
 * is ready, leaving a black native frame despite the detached prefetch decode.
 * This owner only attaches/detaches the node; the payload owner owns its URL.
 */
export function ScreenshotBaseImage({ image, width, height }: {
  image: HTMLImageElement;
  width: number;
  height: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    image.dataset.testid = "screenshot-base-image";
    image.alt = "";
    image.draggable = false;
    image.className = "fixed inset-0 z-0";
    host.current?.appendChild(image);
    return () => { image.remove(); };
  }, [image]);
  useLayoutEffect(() => {
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
  }, [image, width, height]);
  return <div ref={host} />;
}
