import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button";
import { usePendingAction } from "../../../crates/taomni-plugin-api/frontend/ui/usePendingAction";
import { readImagePreview } from "./imagePreview.js";
import styles from "./image.css?inline";

const { React, i18n } = globalThis.__taomniHost;
const { useEffect, useState } = React;

export default function ImageViewer({ document: source }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState();
  const [zoom, setZoom] = useState("fit");
  const [systemError, setSystemError] = useState();
  const [clipboard, setClipboard] = useState();
  const openSystem = usePendingAction(async () => {
    setSystemError(undefined);
    try {
      await source.openSystem();
    } catch (error) {
      setSystemError({ source, detail: error.message ?? String(error) });
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    let url;
    setZoom("fit");
    readImagePreview(source, controller.signal).then(({ blob, width, height }) => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setState({ source, retry, url, width, height });
    }).catch((error) => {
      if (!controller.signal.aborted) setState({ source, retry, error: error.message ?? String(error), code: error.code });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, retry]);

  const loading = state?.source !== source || state.retry !== retry;
  const errors = {
    unsupported: label("此文件格式不支持缩略图。", "This file format does not support thumbnails."),
    format: label("无法解码此 HEIC 照片。", "Could not decode this HEIC photo."),
    limits: label("此 HEIC 照片超出预览限制。", "This HEIC photo exceeds the preview limits."),
    engine: label("无法加载 HEIC 解码器。", "Could not load the HEIC decoder."),
    empty: label("文件内容为空。", "The image file is empty."),
    size: label("图片文件超过 32 MiB 的预览上限。", "The image exceeds the 32 MiB preview limit."),
  };
  const chineseErrors = {
    "raw-format": "无法读取此相机 RAW 文件的目录。",
    "raw-no-preview": "此相机 RAW 文件中没有受支持的内嵌预览图。",
    "psd-format": "无法读取此 Photoshop 文件。",
    "psd-no-preview": "此 Photoshop 文件中没有可显示的预览图。",
    "image-preview-size": "缩略图超出了可预览的尺寸。",
  };
  const message = state && ((locale === "zh-CN" && chineseErrors[state.code]) || errors[state.error] || state.error);
  const copyError = usePendingAction(async () => {
    try {
      await navigator.clipboard.writeText(message);
      setClipboard({ state, success: true });
    } catch {
      setClipboard({ state, success: false });
    }
  });
  return <section className="taoffice-image" data-testid="taoffice-image-viewer" aria-label={source.name} aria-busy={loading}>
    <style>{styles}</style>
    <div className="taoffice-image-tools">
      <span>{label("只读预览", "Read-only preview")}</span>
      {!loading && state.url && <>
        <span data-testid="taoffice-image-dimensions">{state.width} × {state.height}</span>
        <label>{label("缩放", "Zoom")}
          <select className="taomni-input" data-testid="taoffice-image-zoom" value={zoom} onChange={(event) => setZoom(event.target.value)}>
            <option value="fit">{label("适应窗口", "Fit to window")}</option>
            <option value="100">100%</option><option value="200">200%</option>
          </select>
        </label>
      </>}
      <Button data-testid="taoffice-image-open-system" busy={openSystem.busy} onClick={() => void openSystem.run()}>
        {label("用系统应用打开", "Open in system app")}
      </Button>
    </div>
    {systemError?.source === source && <p role="alert">{label("无法打开系统应用。", "Could not open the system app.")} {systemError.detail}</p>}
    {loading ? <p role="status">{label("正在读取缩略图…", "Reading thumbnail…")}</p>
      : state.error ? <div className="taoffice-image-failure">
        <p role="alert" data-testid="taoffice-image-error">{message}</p>
        <Button data-testid="taoffice-image-retry" onClick={() => {
          setSystemError(undefined);
          setRetry((value) => value + 1);
        }}>{label("重试", "Retry")}</Button>
        <Button data-testid="taoffice-image-copy-error" busy={copyError.busy} onClick={() => void copyError.run()}>
          {label("复制错误详情", "Copy error details")}
        </Button>
        {clipboard?.state === state && <p role={clipboard.success ? "status" : "alert"}>
          {clipboard.success ? label("已复制错误详情。", "Error details copied.")
            : label("无法访问剪贴板。可以选中上方的错误详情复制。", "Clipboard unavailable. Select the error message to copy it.")}
        </p>}
      </div> : <div className="taoffice-image-canvas" data-fit={zoom === "fit"}>
        <img data-testid="taoffice-image-thumbnail" src={state.url} alt={source.name}
          style={zoom === "fit" ? undefined : { width: state.width * Number(zoom) / 100 }}/>
      </div>}
  </section>;
}
