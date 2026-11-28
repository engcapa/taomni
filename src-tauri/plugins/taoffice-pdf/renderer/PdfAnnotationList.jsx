const { React } = globalThis.__taomniHost;
const { useEffect, useState } = React;

const kinds = { Highlight: "highlight", Square: "box", Ink: "ink", Text: "note", FreeText: "text" };
const names = { highlight: ["高亮", "Highlight"], box: ["方框", "Rectangle"], ink: ["墨迹", "Ink"],
  note: ["便笺", "Note"], text: ["文字", "Text"] };

export function PdfAnnotationList({ pdf, number, annotations, label }) {
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    let current = true;
    async function read() {
      const page = await pdf.getPage(number);
      const items = await page.getAnnotations({ intent: "display" });
      if (current) setLoaded({ pdf, number, items: items.filter((item) => Object.hasOwn(kinds, item.subtype))
        .map((item) => ({ kind: kinds[item.subtype], text: item.contentsObj?.str })) });
    }
    void read().catch((error) => { if (current) setLoaded({ pdf, number, error: String(error) }); });
    return () => { current = false; };
  }, [pdf, number]);
  const saved = loaded?.pdf === pdf && loaded.number === number ? loaded : null;
  const items = [...(saved?.items ?? []), ...annotations];
  return <>
    {saved?.error && <p role="alert">{saved.error}</p>}
    {items.length > 0 && <ul className="taoffice-pdf-annotation-list" data-testid="taoffice-pdf-annotations"
      aria-label={label("当前页批注", "Annotations on this page")}>
      {items.map(({ kind, text }, index) => <li key={index} data-kind={kind}>
        {label(...names[kind])}{text && <> · {text}</>}
      </li>)}
    </ul>}
  </>;
}
