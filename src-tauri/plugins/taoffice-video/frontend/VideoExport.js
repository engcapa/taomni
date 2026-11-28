import { Button } from "../../../crates/taomni-plugin-api/frontend/ui/Button.tsx";
import { convertInWebView, outputFormats, validClip } from "./conversion.js";
import { convertWithHost } from "./nativeConversion.js";

const { React } = globalThis.__taomniHost;
const { createElement: h, useEffect, useId, useRef, useState } = React;

async function makeCopy(makeFile, api, canNative, options, signal, setProgress) {
  const file = await makeFile();
  signal.throwIfAborted();
  try {
    return await convertInWebView(file, options, signal, setProgress);
  } catch (error) {
    signal.throwIfAborted();
    if (!canNative) throw error;
    setProgress(null);
    return convertWithHost(api, file, options, signal, setProgress);
  }
}

const sizes = [1920, 1280, 960, 640, 320, 160, 80];

export function VideoExport({ source, formats, makeFile, api, canNative, duration, naturalWidth, seek, label }) {
  const id = useId();
  const form = useRef(null);
  const input = useRef(null);
  const trigger = useRef(null);
  const cancelButton = useRef(null);
  const submitButton = useRef(null);
  const operation = useRef(null);
  const focusAfterExport = useRef(null);
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState(() => String(Math.floor(duration * 1000) / 1000));
  const [width, setWidth] = useState("");
  const [container, setContainer] = useState(() => formats.includes("webm") ? "webm" : formats[0]);
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const busy = phase !== "idle";
  const valid = validClip(start, end, duration);

  useEffect(() => () => operation.current?.abort(), []);

  function toggle() {
    if (busy) return;
    if (open) {
      setOpen(false);
      setError("");
      trigger.current?.focus();
    } else {
      setOpen(true);
    }
  }

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!focusAfterExport.current) return;
    const focused = document.activeElement;
    if (focused !== document.body && !form.current?.contains(focused)) {
      focusAfterExport.current = null;
      return;
    }
    if (phase === "converting") cancelButton.current?.focus();
    if (phase === "idle") {
      focusAfterExport.current.current?.focus();
      focusAfterExport.current = null;
    }
  }, [phase]);

  async function submit(event) {
    event.preventDefault();
    if (!valid || operation.current) return;
    setError("");
    setSaved("");
    setPhase("converting");
    setProgress(null);
    const controller = new AbortController();
    operation.current = controller;
    if (form.current?.contains(document.activeElement)) focusAfterExport.current = submitButton;
    const { signal } = controller;
    try {
      const file = await makeCopy(makeFile, api, canNative, {
        container, start: Number(start), end: Number(end), width: width ? Number(width) : undefined,
      }, signal, (fraction) => { if (!signal.aborted) setProgress(fraction); });
      const bytes = new Uint8Array(await file.arrayBuffer());
      signal.throwIfAborted();
      setPhase("saving");
      const path = await source.saveCopy(bytes, { extension: container });
      signal.throwIfAborted();
      if (path) {
        if (focusAfterExport.current) focusAfterExport.current = trigger;
        setOpen(false);
        setSaved(label("已保存视频副本。", "Video copy saved."));
      }
    } catch (reason) {
      if (!signal.aborted) {
        const prefix = label("无法导出视频。", "Could not export video.");
        setError(prefix + (reason?.message ? " " + reason.message : ""));
      }
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        if (form.current?.isConnected) setPhase("idle");
      }
    }
  }

  function timeField(testId, caption, value, setValue, ref) {
    return h("label", null, caption,
      h("input", {
        className: "taomni-input", type: "number", required: true, min: 0, max: duration, step: 0.001,
        value, ref, "data-testid": testId, "aria-invalid": !valid || undefined,
        "aria-describedby": !valid ? id + "-invalid" : undefined,
        onChange: (event) => setValue(event.currentTarget.value),
      }));
  }

  return h("section", { className: "taoffice-media-export" },
    h(Button, {
      ref: trigger, "data-testid": "taoffice-media-export-open", "aria-expanded": open,
      "aria-controls": id, disabled: busy, onClick: toggle,
    }, label("导出视频…", "Export video…")),
    saved && h("p", { role: "status", "data-testid": "taoffice-media-export-saved" }, saved),
    open && h("form", {
      id, ref: form, "data-testid": "taoffice-media-export", className: "taoffice-media-export-form", noValidate: true,
      onKeyDown: (event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === "Enter") event.preventDefault();
          return;
        }
        if (event.key !== "Escape" || phase === "saving" || event.target instanceof HTMLSelectElement) return;
        event.preventDefault();
        event.stopPropagation();
        if (operation.current) operation.current.abort();
        else toggle();
      },
      onSubmit: (event) => void submit(event),
    },
    h("fieldset", { disabled: busy, className: "taoffice-media-export-fields" },
      h("legend", null, label("导出设置", "Export settings")),
      timeField("taoffice-media-trim-start", label("开始时间（秒）", "Start time (seconds)"), start, setStart, input),
      timeField("taoffice-media-trim-end", label("结束时间（秒）", "End time (seconds)"), end, setEnd),
      h("label", null, label("输出宽度", "Output width"),
        h("select", { className: "taomni-input", value: width, "data-testid": "taoffice-media-export-width",
          onChange: (event) => setWidth(event.currentTarget.value) },
          h("option", { value: "" }, label("原始宽度", "Original width")),
          sizes.filter((size) => size < naturalWidth).map((size) => h("option", { value: size, key: size }, size + " px")))),
      h("label", null, label("格式", "Format"),
        h("select", { className: "taomni-input", value: container, "data-testid": "taoffice-media-export-format",
          onChange: (event) => setContainer(event.currentTarget.value) },
          formats.map((value) => h("option", { value, key: value }, outputFormats[value].title))))),
    !valid && h("p", { role: "alert", id: id + "-invalid", "data-testid": "taoffice-media-export-invalid" },
      label("请选择视频时长内的开始和结束时间，精确到毫秒。结束时间必须晚于开始时间。",
        "Choose millisecond times within the video duration. The end must be after the start.")),
    error && h("p", { role: "alert", "data-testid": "taoffice-media-export-error", className: "taoffice-media-error" }, error),
    busy && h("div", { role: "status", className: "taoffice-media-export-progress", "data-testid": "taoffice-media-export-status" },
      phase === "saving" ? label("正在保存视频副本…", "Saving video copy…") : label("正在转换视频…", "Converting video…"),
      phase === "converting" && h("progress", { max: 1, value: progress ?? undefined,
        "aria-label": label("转换进度", "Conversion progress") })),
    h("div", { className: "taoffice-media-actions" },
      h(Button, { disabled: busy || !valid, onClick: () => seek(Number(start)),
        "data-testid": "taoffice-media-export-preview" }, label("预览开始位置", "Preview start")),
      h(Button, { ref: cancelButton, disabled: phase === "saving", onClick: () => {
        if (operation.current) operation.current.abort();
        else toggle();
      }, "data-testid": "taoffice-media-export-cancel" },
      phase === "converting" ? label("取消转换", "Cancel conversion") : label("关闭导出设置", "Close export settings")),
      h(Button, { ref: submitButton, type: "submit", variant: "primary", disabled: !valid, busy,
        "data-testid": "taoffice-media-export-save" }, label("保存视频副本…", "Save video copy…")))));
}
