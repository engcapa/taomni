import { openMediaResource, shouldRetryAsBlob } from "./mediaResource.js";

const { React, i18n } = globalThis.__taomniHost;
const { createElement: h, useEffect, useRef, useState } = React;
const formats = {
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
};

export default function MediaPlayer({ document: source, active }) {
  const { locale } = i18n.useLocale();
  const zh = locale === "zh-CN";
  const [revision, setRevision] = useState(0);
  const [attempt, setAttempt] = useState("stream");
  const [resource, setResource] = useState(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState("");
  const [systemError, setSystemError] = useState("");
  const media = useRef(null);
  const mime = formats[source.extension];
  useEffect(() => {
    let current = true;
    let lease;
    setResource(null);
    setReady(false);
    setFailure("");
    setSystemError("");
    openMediaResource(source, mime, attempt).then((result) => {
      if (!current) { result.close(); return; }
      lease = result;
      setResource({ ...result, attempt });
    }).catch((error) => { if (current) setFailure(String(error)); });
    return () => {
      current = false;
      lease?.close();
    };
  }, [source, mime, revision, attempt]);
  useEffect(() => {
    if (!active && media.current && !media.current.paused) media.current.pause();
  }, [active]);
  function retry() {
    setAttempt("stream");
    setRevision((value) => value + 1);
  }
  function handleMediaError(event) {
    resource.close();
    setResource(null);
    setReady(false);
    if (shouldRetryAsBlob(attempt, resource.url)) {
      setAttempt("blob");
    } else {
      setFailure(event.currentTarget.error?.message
        || (zh ? "当前设备无法解码此媒体。" : "The device could not decode this media."));
    }
  }
  const controls = { className: "taomni-btn", type: "button", style: { minHeight: "max(26px, calc(1em + 8px))", padding: "4px 8px" } };
  return h("section", { "data-testid": "taoffice-media", "aria-label": source.name,
    style: { display: "flex", flexDirection: "column", gap: ".65em", padding: ".8em", minWidth: 0, height: "100%" } },
    h("h2", { style: { overflowWrap: "anywhere", fontWeight: 600 } }, source.name),
    failure ? h("div", { role: "alert", "data-testid": "taoffice-media-error" },
      h("p", null, zh ? "无法播放此文件。请检查文件或使用系统应用打开。" : "This file could not be played. Check the file or open it in a system app."),
      h("p", { style: { overflowWrap: "anywhere", userSelect: "text" } }, failure),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: ".5em", marginBlock: ".5em" } },
        h("button", { ...controls, "data-testid": "taoffice-media-retry", onClick: retry }, zh ? "重试" : "Retry"),
        h("button", { ...controls, onClick: () => {
          setSystemError("");
          source.openSystem().catch((error) => setSystemError(String(error)));
        } }, zh ? "用系统应用打开" : "Open in system app")),
      systemError && h("p", { role: "alert" }, systemError))
    : h(React.Fragment, null,
      !ready && h("p", { role: "status" }, zh ? "正在读取媒体…" : "Loading media…"),
      resource?.attempt === attempt && h(mime.startsWith("audio/") ? "audio" : "video", { key: resource.url, ref: media, src: resource.url, controls: true,
        playsInline: true, preload: "metadata", "aria-label": source.name, "data-testid": "taoffice-media-player",
        "data-ready": ready, style: { width: "100%", minHeight: 0, maxHeight: "100%", objectFit: "contain" },
        onLoadedMetadata: () => setReady(true),
        onError: handleMediaError,
      })));
}
