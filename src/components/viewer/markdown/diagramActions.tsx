import {
  Code2, Copy, FileCode2, FileImage, FlipHorizontal2, FlipVertical2, Maximize, MoveHorizontal,
  RotateCcw, RotateCw, Scan, Search, ZoomIn, ZoomOut, Image, Link, Workflow,
} from "lucide-react";
import type { DiagramView, MarkdownVisualKind } from "./diagramModel";

export type DiagramAction = "open" | "zoom-in" | "zoom-out" | "actual" | "fit" | "width" | "rotate-left" | "rotate-right" | "flip-h" | "flip-v" | "reset" | "save-svg" | "save-png" | "save-drawio" | "copy-drawio-link" | "copy-image" | "copy-text" | "copy-source";
export type DiagramLabel = (zh: string, en: string) => string;
type ActionEntry = { id: DiagramAction; title: string; Icon: typeof Copy; format?: string };

export function diagramActions(label: DiagramLabel, kind: MarkdownVisualKind = "mermaid"): ActionEntry[] {
  const view: ActionEntry[] = [
    { id: "open", title: label("打开大图", "Open large view"), Icon: Search },
    { id: "zoom-in", title: label("放大 (+)", "Zoom in (+)"), Icon: ZoomIn },
    { id: "zoom-out", title: label("缩小 (-)", "Zoom out (-)"), Icon: ZoomOut },
    { id: "actual", title: label("实际大小 (100%)", "Actual size (100%)"), Icon: Scan },
    { id: "fit", title: label("适应窗口 (F)", "Fit to window (F)"), Icon: Maximize },
    { id: "width", title: label("适应宽度 (W)", "Fit to width (W)"), Icon: MoveHorizontal },
    { id: "rotate-left", title: label("向左旋转 90° (Shift+R)", "Rotate left 90° (Shift+R)"), Icon: RotateCcw },
    { id: "rotate-right", title: label("向右旋转 90° (R)", "Rotate right 90° (R)"), Icon: RotateCw },
    { id: "flip-h", title: label("水平翻转", "Flip horizontally"), Icon: FlipHorizontal2 },
    { id: "flip-v", title: label("垂直翻转", "Flip vertically"), Icon: FlipVertical2 },
    { id: "reset", title: label("重置视图", "Reset view"), Icon: RotateCcw },
  ];
  const savePng: ActionEntry = {
    id: "save-png", title: kind === "image" ? label("保存 PNG", "Save PNG") : label("保存高清 PNG", "Save high-resolution PNG"),
    Icon: FileImage, format: "PNG",
  };
  const copyImage: ActionEntry = { id: "copy-image", title: label("复制图片", "Copy image"), Icon: Image };
  if (kind === "image") return [...view, savePng, copyImage];
  return [
    ...view,
    { id: "save-svg", title: label("保存 SVG", "Save SVG"), Icon: FileCode2, format: "SVG" },
    savePng,
    { id: "save-drawio", title: label("保存 draw.io 文件", "Save draw.io file"), Icon: Workflow, format: "draw.io" },
    { id: "copy-drawio-link", title: label("复制 draw.io 在线链接", "Copy draw.io online link"), Icon: Link },
    copyImage,
    { id: "copy-text", title: label("复制图中文字", "Copy diagram text"), Icon: Copy },
    { id: "copy-source", title: kind === "drawio" ? label("复制 draw.io 源码", "Copy draw.io source") : label("复制 Mermaid 源码", "Copy Mermaid source"), Icon: Code2 },
  ];
}
export function applyDiagramAction(view: DiagramView, action: DiagramAction): DiagramView {
  if (action === "reset") return { rotation: 0, flipX: false, flipY: false, mode: "fit", scale: 1, x: 0, y: 0 };
  if (action === "rotate-left" || action === "rotate-right") return { ...view, rotation: ((view.rotation + (action === "rotate-left" ? -90 : 90)) % 360 + 360) % 360 };
  if (action === "flip-h") return { ...view, flipX: !view.flipX };
  if (action === "flip-v") return { ...view, flipY: !view.flipY };
  if (action === "actual" || action === "fit" || action === "width") return { ...view, mode: action, x: 0, y: 0 };
  return view;
}
