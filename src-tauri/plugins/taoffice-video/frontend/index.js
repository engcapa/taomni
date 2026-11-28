import { initialMediaAttempt, mediaSeekTarget, openMediaResource, shouldRetryAsBlob } from "./mediaResource.js";

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
  const firstAttempt = () => initialMediaAttempt(source.extension, (type) => document.createElement("video").canPlayType(type));
  const [attempt, setAttempt] = useState(firstAttempt);
  const [resource, setResource] = useState(null);
  const [progress, setProgress] = useState(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState("");
  const [playError, setPlayError] = useState("");
  const [systemError, setSystemError] = useState("");
  const media = useRef(null);
  const mime = formats[source.extension];
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let lease;
    setResource(null);
    setReady(false);
    setProgress(null);
    setFailure("");
    setPlayError("");
    setSystemError("");
    openMediaResource(source, mime, attempt, signal, (fraction) => {
      if (!signal.aborted) setProgress(fraction);
    }).then((result) => {
      if (signal.aborted) { result.close(); return; }
      lease = result;
      setResource({ ...result, attempt });
    }).catch((error) => { if (!signal.aborted) setFailure(String(error)); });
    return () => {
      controller.abort();
      lease?.close();
    };
  }, [source, mime, revision, attempt]);
  useEffect(() => {
    if (!active && media.current && !media.current.paused) media.current.pause();
  }, [active]);
  function retry() {
    setAttempt(firstAttempt());
    setRevision((value) => value + 1);
  }
  function handleMediaError(event) {
    resource.close();
    setResource(null);
    setReady(false);
    if (source.extension === "mkv" && attempt !== "compatible") {
      setAttempt("compatible");
    } else if (shouldRetryAsBlob(attempt, resource.url)) {
      setAttempt("blob");
    } else {
      setFailure(event.currentTarget.error?.message
        || (zh ? "当前设备无法解码此媒体。" : "The device could not decode this media."));
    }
  }
  function handlePlayerKey(event) {
    if (!active || !ready || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey
      || event.shiftKey || event.altKey) return;
    const player = event.currentTarget;
    const space = event.key === " " || event.code === "Space";
    const seek = event.type === "keydown" ? mediaSeekTarget(player.currentTime, player.duration, event.key) : null;
    if (seek === null && !space) return;
    event.preventDefault();
    event.stopPropagation();
    if (seek !== null) player.currentTime = seek;
    // Native controls can also toggle playback when Space is released.
    if (!space || event.type !== "keyup") return;
    if (player.paused) {
      setPlayError("");
      void player.play().catch((error) => setPlayError(String(error)));
    } else player.pause();
  }
  const controls = { className: "taomni-btn", type: "button", style: { minHeight: "max(26px, calc(1em + 8px))", padding: "4px 8px" } };
  return h("section", { "data-testid": "taoffice-media", "aria-label": source.name,
    style: { display: "flex", flexDirection: "column", gap: ".65em", padding: ".8em", minWidth: 0, height: "100%" } },
    h("h2", { style: { overflowWrap: "anywhere", fontWeight: 600 } }, source.name),
    source.extension === "mkv" && h("label", { style: { display: "flex", alignItems: "center", gap: ".5em" } },
      zh ? "播放方式" : "Playback mode",
      h("select", { className: "taomni-input", "data-testid": "taoffice-media-playback-mode",
        value: attempt === "compatible" ? "compatible" : "stream",
        onChange: (event) => setAttempt(event.currentTarget.value) },
      h("option", { value: "stream" }, zh ? "设备播放" : "Device playback"),
      h("option", { value: "compatible" }, zh ? "兼容播放" : "Compatible playback"))),
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
      !ready && (attempt === "compatible" && !resource
        ? h("div", { role: "status", "data-testid": "taoffice-media-preparing" },
          h("p", null, zh ? "正在准备兼容播放…" : "Preparing compatible playback…"),
          h("progress", { max: 1, value: progress ?? undefined, "aria-label": zh ? "准备进度" : "Preparation progress" }))
        : h("p", { role: "status" }, zh ? "正在读取媒体…" : "Loading media…")),
      playError && h("p", { role: "alert" }, playError),
      resource?.attempt === attempt && h(mime.startsWith("audio/") ? "audio" : "video", { key: resource.url, ref: media, src: resource.url, controls: true,
        playsInline: true, preload: "metadata", tabIndex: 0, "aria-label": source.name, "data-testid": "taoffice-media-player",
        title: zh ? "空格播放或暂停，方向键快退或快进 5 秒" : "Space to play or pause. Left and Right to seek by 5 seconds.",
        "data-ready": ready, "data-playback": attempt,
        style: { width: "100%", minHeight: 0, maxHeight: "100%", objectFit: "contain" },
        onLoadedMetadata: () => setReady(true),
        onKeyDownCapture: handlePlayerKey,
        onKeyUpCapture: handlePlayerKey,
        onError: handleMediaError,
      })));
}
