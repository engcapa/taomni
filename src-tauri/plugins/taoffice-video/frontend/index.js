import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button.tsx";
import { VideoExport } from "./VideoExport.js";
import { outputFormats } from "./conversion.js";
import { fallbackAttempt, initialMediaAttempt, mediaSeekTarget, openMediaResource } from "./mediaResource.js";
import { hasNativeConverter } from "./nativeConversion.js";
import styles from "./media.css?inline";

const { React, i18n } = globalThis.__taomniHost;
const { createElement: h, useEffect, useRef, useState } = React;
const formats = {
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  avi: "video/x-msvideo", flv: "video/x-flv", wmv: "video/x-ms-wmv", rm: "application/vnd.rn-realmedia",
  rmvb: "application/vnd.rn-realmedia-vbr", "3gp": "video/3gpp",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
};

export default function MediaPlayer({ document: source, active, api }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const mime = formats[source.extension];
  const exportFormats = Object.keys(outputFormats).filter((format) => source.copyExtensions?.includes(format));
  const canNative = Boolean(api) && hasNativeConverter();
  const firstAttempt = () => initialMediaAttempt(source.extension, (type) => document.createElement("video").canPlayType(type));
  const [revision, setRevision] = useState(0);
  const [attempt, setAttempt] = useState(firstAttempt);
  const [resource, setResource] = useState(null);
  const [progress, setProgress] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [failure, setFailure] = useState("");
  const [playError, setPlayError] = useState("");
  const [systemError, setSystemError] = useState("");
  const media = useRef(null);
  const pending = useRef(null);
  const preparing = !resource && (attempt === "compatible" || (attempt === "native" && canNative));
  const ready = resource?.attempt === attempt && Boolean(metadata && metadata.url === resource.url);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    pending.current = controller;
    let lease;
    setResource(null);
    setMetadata(null);
    setProgress(null);
    setFailure("");
    setPlayError("");
    setSystemError("");
    openMediaResource(source, mime, attempt, signal, (fraction) => {
      if (!signal.aborted) setProgress(fraction);
    }, api, canNative).then((result) => {
      if (signal.aborted) { result.close(); return; }
      lease = result;
      setResource({ ...result, attempt });
    }).catch((error) => {
      if (signal.aborted) return;
      if (attempt === "compatible" && canNative) setAttempt("native");
      else setFailure(error?.message || String(error));
    });
    return () => {
      controller.abort();
      lease?.close();
      if (pending.current === controller) pending.current = null;
    };
  }, [source, mime, revision, attempt, api, canNative]);

  useEffect(() => {
    if (!active && media.current && !media.current.paused) media.current.pause();
  }, [active]);

  function retry() {
    setAttempt(firstAttempt());
    setRevision((value) => value + 1);
  }

  function cancelPreparation() {
    pending.current?.abort();
    setFailure(label("已取消播放准备。", "Playback preparation cancelled."));
  }

  function handleMediaError(event) {
    if (event.currentTarget !== media.current || !resource) return;
    resource.close();
    setResource(null);
    setMetadata(null);
    const next = fallbackAttempt(source.extension, attempt, canNative, resource.url);
    if (next) setAttempt(next);
    else setFailure(event.currentTarget.error?.message
      || label("当前设备无法解码此媒体。", "The device could not decode this media."));
  }

  function handlePlayerKey(event) {
    if (!active || !ready || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey
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

  function readMetadata(event) {
    const { currentTarget: element } = event;
    if (element !== media.current || !resource) return;
    setMetadata({ url: resource.url, duration: element.duration, width: element.videoWidth });
  }

  return h("section", { "data-testid": "taoffice-media", "aria-label": source.name, className: "taoffice-media" },
    h("style", null, styles),
    h("h2", null, source.name),
    source.extension === "mkv" && h("label", { className: "taoffice-media-mode" },
      label("播放方式", "Playback mode"),
      h("select", { className: "taomni-input", "data-testid": "taoffice-media-playback-mode",
        value: attempt === "native" ? "native" : attempt === "compatible" ? "compatible" : "stream",
        onChange: (event) => setAttempt(event.currentTarget.value) },
      h("option", { value: "stream" }, label("设备播放", "Device playback")),
      h("option", { value: "compatible" }, label("兼容播放", "Compatible playback")),
      canNative && h("option", { value: "native" }, label("转换后播放", "Convert for playback")))),
    failure ? h("div", { role: "alert", "data-testid": "taoffice-media-error", className: "taoffice-media-error" },
      h("p", null, label("无法播放此文件。请检查文件或使用系统应用打开。",
        "This file could not be played. Check the file or open it in a system app.")),
      h("p", null, failure),
      h("div", { className: "taoffice-media-mode" },
        h(Button, { "data-testid": "taoffice-media-retry", onClick: retry }, label("重试", "Retry")),
        h(Button, { "data-testid": "taoffice-media-open-system", onClick: () => {
          setSystemError("");
          source.openSystem().catch((error) => setSystemError(String(error)));
        } }, label("用系统应用打开", "Open in system app"))),
      systemError && h("p", { role: "alert" }, systemError))
    : h(React.Fragment, null,
      !ready && (preparing ? h("div", { role: "status", "data-testid": "taoffice-media-preparing" },
        h("p", null, label("正在准备兼容播放…", "Preparing compatible playback…")),
        h("progress", { max: 1, value: progress ?? undefined, "aria-label": label("准备进度", "Preparation progress") }),
        h(Button, { "data-testid": "taoffice-media-preparing-cancel", onClick: cancelPreparation }, label("取消准备", "Cancel preparation")))
        : h("p", { role: "status" }, label("正在读取媒体…", "Loading media…"))),
      playError && h("p", { role: "alert" }, playError),
      resource?.attempt === attempt && h((resource.file?.type ?? mime).startsWith("audio/") ? "audio" : "video", {
        key: "player:" + resource.url, className: "taoffice-media-surface", ref: media, src: resource.url, controls: true,
        playsInline: true, preload: "metadata", tabIndex: 0, "aria-label": source.name, "data-testid": "taoffice-media-player",
        title: label("空格播放或暂停，方向键快退或快进 5 秒", "Space to play or pause. Left and Right to seek by 5 seconds."),
        "data-ready": ready, "data-playback": attempt, onLoadedMetadata: readMetadata,
        onKeyDownCapture: handlePlayerKey, onKeyUpCapture: handlePlayerKey, onError: handleMediaError,
      }),
      source.saveCopy && exportFormats.length > 0 && ready && metadata.width > 0
        && Number.isFinite(metadata.duration) && metadata.duration >= 0.001
        && h(VideoExport, { key: "export:" + resource.url, source, formats: exportFormats, api, canNative, label,
          // Native export can transcode the original bytes directly. Browser editing of a
          // supported Matroska also operates on its original tracks.
          makeFile: () => source.read(), duration: metadata.duration, naturalWidth: metadata.width,
          seek: (time) => {
            if (!media.current) return;
            media.current.currentTime = time;
            media.current.pause();
          },
        })));
}
