import { AnnotationMode, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { canvasScale, fitPageScale } from "./pdfGeometry.js";
import { normalizePdfText } from "./pdfNavigation.js";

const { React } = globalThis.__taomniHost;
const { useEffect, useRef, useState } = React;

export function PdfPage({ pdf, number, zoom, rotation, viewportWidth, highlight, onScale, label, formRevision }) {
  const canvas = useRef(null);
  const layer = useRef(null);
  const textSpans = useRef([]);
  const [layout, setLayout] = useState(null);
  const [error, setError] = useState("");
  const [renderError, setRenderError] = useState("");
  const [paintedRevision, setPaintedRevision] = useState(null);
  const [textReady, setTextReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void pdf.getPage(number).then((page) => {
      if (cancelled) return;
      const angle = (page.rotate + rotation) % 360;
      const width = page.getViewport({ scale: 1, rotation: angle }).width;
      const scale = zoom ?? fitPageScale(width, viewportWidth);
      const viewport = page.getViewport({ scale, rotation: angle });
      setLayout({ page, viewport, scale });
      onScale(scale);
    }).catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [pdf, number, zoom, rotation, viewportWidth, onScale]);

  useEffect(() => {
    if (!layout) return;
    const { page, viewport } = layout;
    const surface = canvas.current;
    const output = canvasScale(viewport.width, viewport.height, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(viewport.width * output));
    const height = Math.max(1, Math.floor(viewport.height * output));
    let cancelled = false;
    let render;
    async function drawCanvas() {
      if (surface.width !== width) surface.width = width;
      if (surface.height !== height) surface.height = height;
      render = page.render({ canvas: surface, viewport, transform: [output, 0, 0, output, 0, 0],
        annotationMode: AnnotationMode.ENABLE_STORAGE });
      await render.promise;
      if (!cancelled) {
        setPaintedRevision(formRevision);
        setRenderError("");
      }
    }
    void drawCanvas().catch((reason) => { if (!cancelled) setRenderError(String(reason)); });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [layout, formRevision]);

  useEffect(() => {
    if (!layout) return;
    const { page, viewport } = layout;
    const container = layer.current;
    const text = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
    let cancelled = false;
    void text.render().then(() => {
      if (!cancelled) {
        textSpans.current = text.textDivs;
        setTextReady(true);
      }
    }).catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => {
      cancelled = true;
      text.cancel();
      container.replaceChildren();
    };
  }, [layout]);

  useEffect(() => {
    if (!textReady) return;
    for (const span of textSpans.current) {
      span.toggleAttribute("data-search-hit", Boolean(highlight && normalizePdfText(span.textContent ?? "").includes(highlight)));
    }
  }, [textReady, highlight]);

  const dimensions = layout && { width: layout.viewport.width, height: layout.viewport.height,
    "--total-scale-factor": layout.scale };
  const ready = textReady && paintedRevision === formRevision;
  const failure = error || renderError;

  return <>
    {failure && <p role="alert" className="taoffice-pdf-error">{failure}</p>}
    {!failure && paintedRevision === null && <p role="status">{label("正在渲染页面…", "Rendering page…")}</p>}
    <div className="taoffice-pdf-page" style={dimensions ?? undefined}
      data-testid="taoffice-pdf-page" data-page={number} data-rotation={rotation}
      data-scale={layout?.scale} data-ready={ready}>
      <canvas ref={canvas} aria-hidden="true" />
      <div ref={layer} className="textLayer" data-testid="taoffice-pdf-text" />
    </div>
  </>;
}
