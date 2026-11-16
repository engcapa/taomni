// This ESM is copied into the independently signed module archive. It imports
// no second React runtime and owns no subscriptions outside component effects.
import { helloLabels } from "./messages.js";
const host = globalThis.__taomniHost;
if (!host || host.coreApiVersion !== "1") throw new Error("Incompatible Taomni frontend host");
const { createElement: h, useEffect, useRef, useState } = host.React;

export const helloPlugin = { id: "taomni-plugin-hello-plugin", tabKind: "hello-plugin" };

export default function HelloPlugin({ api, active }) {
  const { locale } = host.i18n.useLocale();
  const labels = helloLabels(locale);
  const [value, setValue] = useState("");
  const [values, setValues] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    api.invoke("hello/read", undefined, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setValues(result.values);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(String(reason));
    });
    return () => { alive.current = false; controller.abort(); };
  }, [api]);
  const save = async (event) => {
    event.preventDefault();
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.invoke("hello/write", { value });
      if (alive.current) { setValues(result.values); setValue(""); }
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally { if (alive.current) setBusy(false); }
  };
  return h("div", { "data-testid": "hello-plugin-view", "data-active": String(active), style: { padding: 20 } },
    h("h2", { style: { fontSize: 18, marginBottom: 12 } }, "Hello Plugin"),
    h("form", { onSubmit: save },
      h("label", { htmlFor: "hello-plugin-value" }, labels.message),
      h("input", { id: "hello-plugin-value", "data-testid": "hello-plugin-value", className: "taomni-input",
        maxLength: 4096, value, disabled: busy, onChange: (event) => setValue(event.target.value), style: { margin: 8 } }),
      h("button", { type: "submit", "data-testid": "hello-plugin-save", className: "taomni-btn", disabled: busy || !value.trim(),
        style: { padding: "4px 12px" } }, busy ? labels.saving : labels.save)),
    error && h("p", { role: "alert", "data-testid": "hello-plugin-error" }, error),
    values === null ? h("p", { role: "status" }, labels.loading) : h("ul", {
      "data-testid": "hello-plugin-values", "data-state": values.length === 0 ? "empty" : "populated",
    }, values.length === 0
      ? h("li", { "data-testid": "hello-plugin-empty", style: { color: "var(--taomni-text-muted)" } }, labels.empty)
      : values.map((entry, index) => h("li", { key: index, "data-testid": "hello-plugin-entry" }, entry))));
}
