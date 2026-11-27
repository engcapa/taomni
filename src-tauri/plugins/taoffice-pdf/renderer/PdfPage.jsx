import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { canvasScale, fitPageScale } from "./pdfGeometry.js";

const { React } = globalThis.__taomniHost;
const { useEffect, useRef, useState } = React;

export function PdfPage({ pdf, number, zoom, rotation, viewportWidth, label }) {
  const canvas = useRef(null);
  const layer = useRef(null);
  const [dimensions, setDimensions] = useState(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let render;
    let text;
    const surface = canvas.current;
    const textContainer = layer.current;
    async function draw() {
      const page = await pdf.getPage(number);
      if (cancelled) return;
      const angle = (page.rotate + rotation) % 360;
      const width = page.getViewport({ scale: 1, rotation: angle }).width;
      const scale = zoom ?? fitPageScale(width, viewportWidth);
      const viewport = page.getViewport({ scale, rotation: angle });
      const output = canvasScale(viewport.width, viewport.height, window.devicePixelRatio || 1);
      surface.width = Math.max(1, Math.floor(viewport.width * output));
      surface.height = Math.max(1, Math.floor(viewport.height * output));
      setDimensions({ width: viewport.width, height: viewport.height, "--total-scale-factor": scale });
      render = page.render({ canvas: surface, viewport, transform: [output, 0, 0, output, 0, 0] });
      text = new TextLayer({ textContentSource: page.streamTextContent(), container: textContainer, viewport });
      await Promise.all([render.promise, text.render()]);
      if (!cancelled) setReady(true);
    }
    void draw().catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => {
      cancelled = true;
      render?.cancel();
      text?.cancel();
    };
  }, [pdf, number, zoom, rotation, viewportWidth]);

  return <>
    {error && <p role="alert" className="taoffice-pdf-error">{error}</p>}
    {!error && !ready && <p role="status">{label("正在渲染页面…", "Rendering page…")}</p>}
    <div className="taoffice-pdf-page" style={dimensions ?? undefined}
      data-testid="taoffice-pdf-page" data-page={number} data-rotation={rotation} data-ready={ready}>
      <canvas ref={canvas} aria-hidden="true" />
      <div ref={layer} className="textLayer" data-testid="taoffice-pdf-text" />
    </div>
  </>;
}
