import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button.tsx";
import { createPresentation } from "./createPresentation.js";

const { React } = globalThis.__taomniHost;
const { useEffect, useId, useRef, useState } = React;

export function NewPresentation({ source, active, restoreFocus, label }) {
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const input = useRef(null);
  const id = useId();
  const hasTitle = Boolean(title.trim());
  useEffect(() => { input.current?.focus(); }, []);
  async function save(event) {
    event.preventDefault();
    if (working.current || !title.trim() || event.nativeEvent.isComposing) return;
    working.current = true;
    setBusy(true);
    setOutput("");
    setError(false);
    try {
      const path = await source.saveCopy(await createPresentation(title.trim(), subtitle.trim()));
      if (path) setOutput(path);
    } catch {
      setError(true);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  return <form className="taoffice-ppt-editor" aria-label={label("新建演示文稿", "New presentation")}
    onSubmit={(event) => void save(event)} onKeyDown={(event) => {
      const composing = event.nativeEvent.isComposing || event.keyCode === 229;
      if (composing && event.key === "Enter") event.preventDefault();
      if (!active || composing || event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      restoreFocus();
    }}>
    <label>
      <span data-testid="taoffice-ppt-new-title-label">{label("标题", "Title")}</span>
      <input ref={input} className="taomni-input" type="text" value={title} maxLength={120} required
        data-testid="taoffice-ppt-new-title" disabled={busy} aria-describedby={!hasTitle ? id : undefined}
        onChange={(event) => setTitle(event.target.value)} />
    </label>
    <label>
      <span>{label("副标题", "Subtitle")}</span>
      <input className="taomni-input" type="text" value={subtitle} maxLength={200} disabled={busy}
        data-testid="taoffice-ppt-new-subtitle" onChange={(event) => setSubtitle(event.target.value)} />
    </label>
    {!hasTitle && <p id={id} className="taoffice-ppt-feedback">{label("请输入标题。", "Enter a title.")}</p>}
    {error && <p className="taoffice-ppt-feedback" role="alert">{label("无法保存演示文稿。", "Could not save the presentation.")}</p>}
    {output && <p role="status" className="taoffice-ppt-feedback" data-testid="taoffice-ppt-new-output">{output}</p>}
    <div className="taoffice-ppt-actions">
      <Button disabled={busy} onClick={restoreFocus}>{label("返回幻灯片", "Back to slides")}</Button>
      <Button variant="primary" type="submit" disabled={!hasTitle} busy={busy} aria-describedby={!hasTitle ? id : undefined}
        data-testid="taoffice-ppt-new-save">{label("保存新演示文稿…", "Save new presentation…")}</Button>
    </div>
  </form>;
}
