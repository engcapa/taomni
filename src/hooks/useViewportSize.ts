import { useEffect, useState } from "react";

export interface ViewportSize {
  width: number;
  height: number;
}

function currentSize(): ViewportSize {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Reactive window inner size; updates on resize. */
export function useViewportSize(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(() => currentSize());
  useEffect(() => {
    const onResize = () => setSize(currentSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}
