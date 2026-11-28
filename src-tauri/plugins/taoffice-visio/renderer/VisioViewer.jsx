import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button";
import { usePendingAction } from "../../../crates/taomni-plugin-api/frontend/ui/usePendingAction";
import { VisioPages } from "./VisioPages.jsx";
import { openVisio } from "./visioDocument.js";
import styles from "./visio.css?inline";

const { React, i18n } = globalThis.__taomniHost;
const { useEffect, useState } = React;

export default function VisioViewer({ document: source, active }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const [state, setState] = useState(null);
  const [retry, setRetry] = useState(0);
  const [systemError, setSystemError] = useState("");
  const systemAction = usePendingAction(async () => {
    setSystemError("");
    try {
      await source.openSystem();
    } catch (error) {
      setSystemError(error.message ?? String(error));
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    openVisio(source, signal).then((pages) => {
      if (!signal.aborted) setState({ source, retry, pages });
    }).catch((error) => {
      if (!signal.aborted) setState({ source, retry, error: error.message ?? String(error) });
    });
    return () => controller.abort();
  }, [source, retry]);

  const loading = state?.source !== source || state.retry !== retry;
  const openSystem = <Button data-testid="taoffice-visio-open-system" busy={systemAction.busy}
    onClick={() => void systemAction.run()}>{label("用系统应用打开", "Open in system app")}</Button>;
  const errors = {
    format: label("文件已损坏，或使用不受支持的 Visio 格式。", "The file is damaged or uses an unsupported Visio format."),
    limits: label("图形超出预览限制。", "The diagram exceeds preview limits."),
    engine: label("无法加载 Visio 预览引擎。", "Could not load the Visio preview engine."),
  };
  return <section className="taoffice-visio" aria-label={source.name} aria-busy={loading} data-testid="taoffice-visio">
    <style>{styles}</style>
    {loading ? <p className="taoffice-visio-status" role="status">{label("正在打开 Visio 图形…", "Opening Visio diagram…")}</p>
      : state.error ? <div className="taoffice-visio-failure">
          <p role="alert" data-testid="taoffice-visio-error">{errors[state.error] ?? state.error}</p>
          <div className="taoffice-visio-actions">
            <Button data-testid="taoffice-visio-retry" onClick={() => {
              setSystemError("");
              setRetry((value) => value + 1);
            }}>{label("重试", "Retry")}</Button>
            {openSystem}
          </div>
        </div>
        : <VisioPages pages={state.pages} source={source} active={active} label={label} openSystem={openSystem} />}
    {systemError && <p className="taoffice-visio-status" role="alert">
      {label("系统应用打开失败。请检查文件关联。", "Could not open the system app. Check the file association.")} {systemError}
    </p>}
  </section>;
}
