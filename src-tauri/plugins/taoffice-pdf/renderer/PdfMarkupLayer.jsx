const { React } = globalThis.__taomniHost;
const { useRef, useState } = React;
const clamp = (value, bound) => Math.max(0, Math.min(value, bound));

function fromPointer(event, viewport) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return [
    clamp((event.clientX - bounds.left) * viewport.width / bounds.width, viewport.width),
    clamp((event.clientY - bounds.top) * viewport.height / bounds.height, viewport.height),
  ];
}

function markupElement({ kind, points, text }, viewport, index) {
  const mapped = points.map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const [first, last = first] = mapped;
  if (kind === "ink") return <polyline key={index} points={mapped.map((position) => position.join(",")).join(" ")}
    className="taoffice-pdf-markup-ink" data-testid="taoffice-pdf-markup" data-kind={kind} />;
  if (kind === "note") {
    const [[x, y]] = points;
    const corner = viewport.convertToViewportPoint(x + 16, y - 16);
    return <rect key={index} x={Math.min(first[0], corner[0])} y={Math.min(first[1], corner[1])}
      width={Math.abs(corner[0] - first[0])} height={Math.abs(corner[1] - first[1])}
      className="taoffice-pdf-markup-note" data-testid="taoffice-pdf-markup" data-kind={kind}>
      <title>{text}</title>
    </rect>;
  }
  return <rect key={index} x={Math.min(first[0], last[0])} y={Math.min(first[1], last[1])}
    width={Math.abs(last[0] - first[0])} height={Math.abs(last[1] - first[1])}
    className={`taoffice-pdf-markup-${kind}`} data-testid="taoffice-pdf-markup" data-kind={kind} />;
}

export function PdfMarkupLayer({ viewport, tool, note, annotations, onAdd, label }) {
  const pointer = useRef(null);
  const [preview, setPreview] = useState(null);
  const [cursor, setCursor] = useState(null);
  const enabled = Boolean(tool && (tool !== "note" || note.trim()));
  const toPdf = ([x, y]) => viewport.convertToPdfPoint(x, y);
  const location = cursor ?? [viewport.width / 2, viewport.height / 2];
  function mark(points) {
    if (tool === "note") onAdd({ kind: tool, points: [toPdf(points[0])], text: note.trim() });
    else onAdd({ kind: tool, points: points.map(toPdf) });
  }
  function clear() {
    pointer.current = null;
    setPreview(null);
  }
  if (!annotations.length && !tool) return null;

  return <svg className="taoffice-pdf-markup-layer" viewBox={`0 0 ${viewport.width} ${viewport.height}`}
    data-testid="taoffice-pdf-markup-surface" data-tool={tool || undefined} data-interactive={enabled}
    tabIndex={enabled ? 0 : undefined} role={enabled ? "button" : undefined}
    aria-label={enabled ? label("在页面上添加批注", "Add an annotation to the page") : undefined}
    aria-hidden={enabled ? undefined : true}
    onKeyDown={(event) => {
      if (!enabled || event.nativeEvent.isComposing) return;
      const directions = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] };
      const direction = directions[event.key];
      if (!direction && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      const [x, y] = location;
      if (direction) {
        setCursor([clamp(x + direction[0], viewport.width), clamp(y + direction[1], viewport.height)]);
      } else {
        const left = clamp(x, Math.max(0, viewport.width - 24));
        const top = clamp(y, Math.max(0, viewport.height - 16));
        mark(tool === "note" ? [location] : [[left, top], [left + 24, top + 16]]);
      }
    }}
    onPointerDown={(event) => {
      if (!enabled || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      const point = fromPointer(event, viewport);
      if (tool === "note") { mark([point]); return; }
      event.currentTarget.setPointerCapture(event.pointerId);
      pointer.current = { id: event.pointerId, points: [point] };
    }}
    onPointerMove={(event) => {
      if (pointer.current?.id !== event.pointerId) return;
      const point = fromPointer(event, viewport);
      const points = pointer.current.points;
      if (tool === "ink" && points.length < 511) points.push(point);
      setPreview({ kind: tool, points: [...points, point].map(toPdf) });
    }}
    onPointerUp={(event) => {
      if (pointer.current?.id !== event.pointerId) return;
      const points = [...pointer.current.points, fromPointer(event, viewport)];
      const start = points[0];
      const end = points.at(-1);
      if (enabled && (tool === "ink" ? points.some(([x, y]) => Math.hypot(x - start[0], y - start[1]) >= 3)
        : Math.abs(end[0] - start[0]) >= 3 && Math.abs(end[1] - start[1]) >= 3)) mark(points);
      clear();
    }} onPointerCancel={clear} onLostPointerCapture={clear}>
    {annotations.map((item, index) => markupElement(item, viewport, index))}
    {preview && markupElement(preview, viewport, "preview")}
    {enabled && <circle className="taoffice-pdf-markup-cursor" cx={location[0]} cy={location[1]} r={4} />}
  </svg>;
}
