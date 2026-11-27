const { React } = globalThis.__taomniHost;
const { useEffect, useId, useRef, useState } = React;

export function PdfPassword({ active, challenge, label, onSubmit, onCancel }) {
  const [filled, setFilled] = useState(false);
  const input = useRef(null);
  const feedback = useId();
  const checking = !challenge.submit;

  useEffect(() => {
    if (active && challenge.submit) input.current?.focus();
  }, [active, challenge]);

  return <form className="taoffice-pdf-password" aria-label={label("解锁 PDF", "Unlock PDF")}
    onSubmit={(event) => {
      event.preventDefault();
      if (!active || !challenge.submit || !input.current?.value) return;
      const password = input.current.value;
      input.current.value = "";
      setFilled(false);
      onSubmit(password);
    }} onKeyDown={(event) => {
      const composing = event.nativeEvent.isComposing || event.keyCode === 229;
      if (composing && event.key === "Enter") event.preventDefault();
      if (!composing && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    }}>
    <label>{label("文档密码", "Document password")}
      <input ref={input} type="password" autoComplete="off" className="taomni-input"
        data-testid="taoffice-pdf-password" disabled={checking} aria-invalid={challenge.incorrect}
        aria-describedby={feedback} onChange={(event) => setFilled(event.target.value.length > 0)} />
    </label>
    <p id={feedback} role={challenge.incorrect ? "alert" : "status"} data-testid="taoffice-pdf-password-status">
      {checking ? label("正在验证密码…", "Checking password…")
        : challenge.incorrect ? label("密码不正确，请重试。", "Incorrect password. Try again.")
          : label("输入密码以打开此 PDF。", "Enter the password to open this PDF.")}
    </p>
    <div>
      <button type="submit" className="taomni-btn" data-testid="taoffice-pdf-unlock" disabled={!filled || checking}>
        {label("解锁", "Unlock")}
      </button>
      <button type="button" className="taomni-btn" data-testid="taoffice-pdf-password-cancel" onClick={onCancel}>
        {label("取消", "Cancel")}
      </button>
    </div>
  </form>;
}
