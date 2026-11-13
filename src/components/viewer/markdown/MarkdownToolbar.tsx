import {
  Bold, ChevronDown, Code, CodeXml, Focus, Heading, ImagePlus, Italic, Link,
  List, ListChecks, ListOrdered, ListTree, Minus, Quote, Strikethrough, Table,
} from "lucide-react";
import type { EditorView } from "@codemirror/view";
import { useViewerLabels } from "../viewerLabels";
import { formatMarkdown, setMarkdownHeading, type MarkdownFormat } from "./markdownCommands";

export type MarkdownMode = "live" | "source" | "split";
export function MarkdownToolbar({ view, readOnly, mode, focus, outline, heading, onMode, onFocus, onOutline, onImage }: {
  view: () => EditorView | null; readOnly: boolean; mode: MarkdownMode; focus: boolean; outline: boolean; heading: number;
  onMode: (mode: MarkdownMode) => void; onFocus: () => void; onOutline: () => void; onImage: () => void;
}) {
  const label = useViewerLabels();
  const chord = /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";
  const button = (action: MarkdownFormat, zh: string, en: string, Icon: typeof Bold, shortcut = "") => <button key={action} className="fv-icon-button" data-testid={`markdown-format-${action}`} title={`${label(zh, en)}${shortcut ? ` ${chord}${shortcut}` : ""}`} aria-label={label(zh, en)} disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => { const editor = view(); if (editor) formatMarkdown(editor, action); }}><Icon /></button>;
  return <>
    <div className="fv-md-format" role="toolbar" aria-label={label("Markdown 格式", "Markdown formatting")}>
      <label className="fv-md-heading-select fv-button outline"><select data-testid="markdown-heading" aria-label={label("段落样式", "Paragraph style")} value={heading} disabled={readOnly} onChange={(event) => { const editor = view(); if (editor) setMarkdownHeading(editor, Number(event.target.value)); }}><option value={0}>{label("正文", "Body")}</option>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>{label("标题", "Heading")} {level}</option>)}</select><ChevronDown /></label>
      <span className="fv-separator" />
      {button("bold", "粗体", "Bold", Bold, "B")}{button("italic", "斜体", "Italic", Italic, "I")}{button("strike", "删除线", "Strikethrough", Strikethrough)}{button("code", "行内代码", "Inline code", Code)}{button("link", "链接", "Link", Link, "K")}
      <span className="fv-separator" />
      {button("bullet", "无序列表", "Bullet list", List)}{button("ordered", "有序列表", "Numbered list", ListOrdered)}{button("task", "任务列表", "Task list", ListChecks)}{button("quote", "引用", "Quote", Quote)}
      <span className="fv-separator" />
      {button("table", "插入表格", "Insert table", Table)}<button className="fv-icon-button" data-testid="markdown-insert-image" title={label("插入图片", "Insert image")} aria-label={label("插入图片", "Insert image")} disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={onImage}><ImagePlus /></button>{button("codeblock", "代码块", "Code block", CodeXml)}{button("hr", "分隔线", "Horizontal rule", Minus)}
    </div>
    <span className="fv-spacer" />
    <div className="fv-seg" aria-label={label("Markdown 模式", "Markdown mode")}>{(["live", "source", "split"] as const).map((value) => <button key={value} data-testid={`markdown-mode-${value}`} className={value === mode ? "on" : ""} aria-pressed={value === mode} onClick={() => onMode(value)}>{value === "live" ? label("实时", "Live") : value === "source" ? label("源码", "Source") : label("分栏", "Split")}</button>)}</div>
    <button className={`fv-icon-button ${focus ? "on" : ""}`} data-testid="markdown-focus" title={label("专注模式", "Focus mode")} aria-label={label("专注模式", "Focus mode")} aria-pressed={focus} onClick={onFocus}><Focus /></button>
    <button className={`fv-icon-button fv-md-outline-toggle ${outline ? "on" : ""}`} data-testid="markdown-outline-toggle" title={label("大纲", "Outline")} aria-label={label("大纲", "Outline")} aria-pressed={outline} onClick={onOutline}><ListTree /></button>
  </>;
}

export function MarkdownInsertMenu({ from, onInsert }: { from: number; onInsert: (from: number, action: MarkdownFormat | "heading" | "image") => void }) {
  const label = useViewerLabels();
  const options: Array<[MarkdownFormat | "heading" | "image", string, string, typeof Bold]> = [
    ["heading", "标题", "Heading", Heading], ["table", "表格", "Table", Table], ["image", "图片", "Image", ImagePlus],
    ["codeblock", "代码块", "Code block", CodeXml], ["formula", "公式（代码块）", "Formula (code block)", Code], ["mermaid", "Mermaid 图表", "Mermaid diagram", ListTree],
  ];
  return <div className="fv-menu fv-md-insert-menu" data-testid="markdown-insert-menu" role="menu" aria-label={label("插入", "Insert")}>{options.map(([action, zh, en, Icon]) => <button key={action} role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => onInsert(from, action)}><Icon />{label(zh, en)}</button>)}</div>;
}
