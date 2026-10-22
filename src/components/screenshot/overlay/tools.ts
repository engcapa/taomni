import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, Circle, Droplets, Eraser, Highlighter, LayoutGrid, ListOrdered, MessageCircle, Minus, MousePointer2, Pencil, Square, Type } from "lucide-react";
import { type AnnotationTool } from "../AnnotationCanvas";

export const COLORS: { value: string; testid: string; titleKey: string; }[] = [
  { value: "#ff4d4f", testid: "screenshot-color-red", titleKey: "screenshot.colorRed" },
  { value: "#fa8c16", testid: "screenshot-color-orange", titleKey: "screenshot.colorOrange" },
  { value: "#faad14", testid: "screenshot-color-yellow", titleKey: "screenshot.colorYellow" },
  { value: "#52c41a", testid: "screenshot-color-green", titleKey: "screenshot.colorGreen" },
  { value: "#13c2c2", testid: "screenshot-color-cyan", titleKey: "screenshot.colorCyan" },
  { value: "#1677ff", testid: "screenshot-color-blue", titleKey: "screenshot.colorBlue" },
  { value: "#722ed1", testid: "screenshot-color-purple", titleKey: "screenshot.colorPurple" },
  { value: "#eb2f96", testid: "screenshot-color-pink", titleKey: "screenshot.colorPink" },
  { value: "#8c8c8c", testid: "screenshot-color-gray", titleKey: "screenshot.colorGray" },
  { value: "#000000", testid: "screenshot-color-black", titleKey: "screenshot.colorBlack" },
  { value: "#ffffff", testid: "screenshot-color-white", titleKey: "screenshot.colorWhite" },
];

export const TOOLS: { tool: AnnotationTool; testid: string; titleKey: string; Icon: LucideIcon; }[] = [
  { tool: "move", testid: "screenshot-tool-move", titleKey: "screenshot.toolMove", Icon: MousePointer2 },
  { tool: "rect", testid: "screenshot-tool-rect", titleKey: "screenshot.toolRect", Icon: Square },
  { tool: "ellipse", testid: "screenshot-tool-ellipse", titleKey: "screenshot.toolEllipse", Icon: Circle },
  { tool: "arrow", testid: "screenshot-tool-arrow", titleKey: "screenshot.toolArrow", Icon: ArrowUpRight },
  { tool: "line", testid: "screenshot-tool-line", titleKey: "screenshot.toolLine", Icon: Minus },
  { tool: "pen", testid: "screenshot-tool-pen", titleKey: "screenshot.toolPen", Icon: Pencil },
  { tool: "highlighter", testid: "screenshot-tool-highlighter", titleKey: "screenshot.toolHighlighter", Icon: Highlighter },
  { tool: "text", testid: "screenshot-tool-text", titleKey: "screenshot.toolText", Icon: Type },
  { tool: "balloon", testid: "screenshot-tool-balloon", titleKey: "screenshot.toolBalloon", Icon: MessageCircle },
  { tool: "mosaic", testid: "screenshot-tool-mosaic", titleKey: "screenshot.toolMosaic", Icon: LayoutGrid },
  { tool: "blur", testid: "screenshot-tool-blur", titleKey: "screenshot.toolBlur", Icon: Droplets },
  { tool: "number", testid: "screenshot-tool-number", titleKey: "screenshot.toolNumber", Icon: ListOrdered },
  { tool: "eraser", testid: "screenshot-tool-eraser", titleKey: "screenshot.toolEraser", Icon: Eraser },
];

export const LINE_WIDTHS = [2, 4, 8];
