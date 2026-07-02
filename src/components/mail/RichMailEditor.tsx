import { useEffect, useRef, useState, type ClipboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Anchor,
  Bold,
  ChevronDown,
  Eraser,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Table2,
  Smile,
  Underline,
} from "lucide-react";
import { mailHtmlToPlainText, sanitizeMailComposeHtml } from "../../lib/mailHtml";
import { useContextMenu, type MenuItem } from "../ContextMenu";

interface RichMailEditorProps {
  html: string;
  disabled?: boolean;
  onChange: (html: string, text: string) => void;
  onRichFormatUsed?: () => void;
  onAttach?: () => void;
  onInlineImage?: () => string | null | Promise<string | null>;
}

const PARAGRAPH_OPTIONS = [
  { value: "p", label: "Paragraph" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "blockquote", label: "Quote" },
  { value: "pre", label: "Preformatted" },
];

const FONT_OPTIONS = [
  { value: "Arial", label: "Arial" },
  { value: "Georgia", label: "Georgia" },
  { value: "Times New Roman", label: "Times" },
  { value: "Courier New", label: "Courier" },
  { value: "Inter", label: "Inter" },
];

const SIZE_OPTIONS = [
  { value: "2", label: "12" },
  { value: "3", label: "14" },
  { value: "4", label: "18" },
  { value: "5", label: "24" },
];

const EMOJI_OPTIONS = [
  { id: "smile", label: "微笑", value: "🙂" },
  { id: "frown", label: "皱眉", value: "🙁" },
  { id: "wink", label: "眨眼", value: "😉" },
  { id: "tongue", label: "吐舌", value: "😛" },
  { id: "laugh", label: "大笑", value: "😂" },
  { id: "blush", label: "窘迫", value: "😳" },
  { id: "unsure", label: "迟疑", value: "😕" },
  { id: "surprise", label: "惊讶", value: "😮" },
  { id: "kiss", label: "亲吻", value: "😘" },
  { id: "shout", label: "大叫", value: "😱" },
  { id: "cool", label: "酷", value: "😎" },
  { id: "money", label: "爱财", value: "🤑" },
  { id: "sealed", label: "失言", value: "😶" },
  { id: "innocent", label: "无辜", value: "😇" },
  { id: "cry", label: "哭泣", value: "😭" },
  { id: "silent", label: "缄默", value: "🤐" },
];

export function RichMailEditor({
  html,
  disabled = false,
  onChange,
  onRichFormatUsed,
  onAttach,
  onInlineImage,
}: RichMailEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [color, setColor] = useState("#1f2937");
  const editorMenu = useContextMenu();

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = html || "<p><br></p>";
    if (editor.innerHTML !== next) editor.innerHTML = next;
  }, [html]);

  const emitChange = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const nextHtml = editor.innerHTML || "<p><br></p>";
    onChange(nextHtml, mailHtmlToPlainText(nextHtml));
  };

  const focusEditor = () => {
    editorRef.current?.focus();
  };

  const exec = (command: string, value?: string, rich = true) => {
    if (disabled) return;
    focusEditor();
    document.execCommand(command, false, value);
    if (rich) onRichFormatUsed?.();
    emitChange();
  };

  const insertHtml = (value: string, rich = true) => {
    if (disabled) return;
    focusEditor();
    document.execCommand("insertHTML", false, value);
    if (rich) onRichFormatUsed?.();
    emitChange();
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const pastedHtml = event.clipboardData.getData("text/html");
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedHtml) {
      insertHtml(sanitizeMailComposeHtml(pastedHtml), true);
      return;
    }
    if (pastedText) insertHtml(escapeHtml(pastedText).replace(/\r?\n/g, "<br>"), false);
  };

  const handleLink = () => {
    const href = window.prompt("Link URL");
    if (!href?.trim()) return;
    exec("createLink", href.trim());
  };

  const handleAnchor = () => {
    const name = window.prompt("Anchor name");
    const cleaned = name?.trim().replace(/\s+/g, "-");
    if (!cleaned) return;
    insertHtml(`<a name="${escapeHtml(cleaned)}"></a>`, true);
  };

  const handleInlineImage = async () => {
    const imageHtml = await onInlineImage?.();
    if (!imageHtml) return;
    insertHtml(imageHtml, true);
  };

  const handleTable = () => {
    const raw = window.prompt("Table size (columns x rows)", "2x2");
    if (!raw) return;
    const match = /^\s*(\d{1,2})\s*[x*,]\s*(\d{1,2})\s*$/i.exec(raw);
    const cols = Math.max(1, Math.min(12, Number(match?.[1] ?? 2)));
    const rows = Math.max(1, Math.min(20, Number(match?.[2] ?? 2)));
    insertHtml(buildTableHtml(cols, rows), true);
  };

  const showMenu = (event: ReactMouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    editorMenu.showAt(rect.left, rect.bottom + 4, items);
  };

  const emojiMenuItems = (): MenuItem[] => EMOJI_OPTIONS.map((emoji) => ({
    label: `${emoji.value} ${emoji.label}`,
    testId: `mail-compose-emoji-${emoji.id}`,
    onClick: () => insertHtml(emoji.value, false),
  }));

  const insertMenuItems = (): MenuItem[] => [
    {
      label: "链接",
      testId: "mail-compose-insert-link",
      icon: <LinkIcon className="w-3.5 h-3.5" />,
      onClick: handleLink,
    },
    {
      label: "锚标",
      testId: "mail-compose-insert-anchor",
      icon: <Anchor className="w-3.5 h-3.5" />,
      onClick: handleAnchor,
    },
    {
      label: "图像",
      testId: "mail-compose-insert-image",
      icon: <ImageIcon className="w-3.5 h-3.5" />,
      disabled: !onInlineImage,
      onClick: () => void handleInlineImage(),
    },
    {
      label: "水平线",
      testId: "mail-compose-insert-hr",
      icon: <Minus className="w-3.5 h-3.5" />,
      onClick: () => insertHtml("<hr>", true),
    },
    {
      label: "表格",
      testId: "mail-compose-insert-table",
      icon: <Table2 className="w-3.5 h-3.5" />,
      onClick: handleTable,
    },
  ];

  return (
    <div className="mx-3 mb-3 min-h-0 flex-1 flex flex-col border border-[var(--taomni-input-border)] rounded-md overflow-hidden bg-[var(--taomni-input-bg)]">
      <div
        className="min-h-9 px-2 py-1 flex flex-wrap items-center gap-1 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)]"
        data-testid="mail-compose-format-toolbar"
      >
        <select
          className="taomni-input h-7 w-[104px] text-[12px]"
          aria-label="Paragraph style"
          data-testid="mail-compose-format-block"
          disabled={disabled}
          onChange={(event) => exec("formatBlock", event.target.value)}
        >
          {PARAGRAPH_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          className="taomni-input h-7 w-[120px] text-[12px]"
          aria-label="Font family"
          data-testid="mail-compose-font-family"
          disabled={disabled}
          onChange={(event) => exec("fontName", event.target.value)}
        >
          {FONT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          className="taomni-input h-7 w-[64px] text-[12px]"
          aria-label="Font size"
          data-testid="mail-compose-font-size"
          disabled={disabled}
          onChange={(event) => exec("fontSize", event.target.value)}
        >
          {SIZE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <input
          type="color"
          className="h-7 w-8 rounded border border-[var(--taomni-input-border)] bg-transparent"
          aria-label="Text color"
          title="Text color"
          data-testid="mail-compose-text-color"
          value={color}
          disabled={disabled}
          onChange={(event) => {
            setColor(event.target.value);
            exec("foreColor", event.target.value);
          }}
        />
        <ToolbarButton label="Bold" testId="mail-compose-bold" disabled={disabled} onClick={() => exec("bold")}><Bold className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Italic" testId="mail-compose-italic" disabled={disabled} onClick={() => exec("italic")}><Italic className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Underline" testId="mail-compose-underline" disabled={disabled} onClick={() => exec("underline")}><Underline className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Clear formatting" testId="mail-compose-clear-format" disabled={disabled} onClick={() => exec("removeFormat")}><Eraser className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Bulleted list" testId="mail-compose-bullet-list" disabled={disabled} onClick={() => exec("insertUnorderedList")}><List className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Numbered list" testId="mail-compose-number-list" disabled={disabled} onClick={() => exec("insertOrderedList")}><ListOrdered className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Decrease indent" testId="mail-compose-outdent" disabled={disabled} onClick={() => exec("outdent")}><IndentDecrease className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Increase indent" testId="mail-compose-indent" disabled={disabled} onClick={() => exec("indent")}><IndentIncrease className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Align left" testId="mail-compose-align-left" disabled={disabled} onClick={() => exec("justifyLeft")}><AlignLeft className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Align center" testId="mail-compose-align-center" disabled={disabled} onClick={() => exec("justifyCenter")}><AlignCenter className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Align right" testId="mail-compose-align-right" disabled={disabled} onClick={() => exec("justifyRight")}><AlignRight className="w-3.5 h-3.5" /></ToolbarButton>
        <ToolbarButton label="Insert link" testId="mail-compose-link" disabled={disabled} onClick={handleLink}><LinkIcon className="w-3.5 h-3.5" /></ToolbarButton>
        <MenuButton label="Insert" testId="mail-compose-insert-menu" disabled={disabled} onClick={(event) => showMenu(event, insertMenuItems())}>
          <ImageIcon className="w-3.5 h-3.5" />
        </MenuButton>
        <MenuButton label="Insert emoticon" testId="mail-compose-emoji" disabled={disabled} onClick={(event) => showMenu(event, emojiMenuItems())}>
          <Smile className="w-3.5 h-3.5" />
        </MenuButton>
        {onAttach && (
          <button
            type="button"
            className="taomni-btn h-7 px-2 text-[12px]"
            data-testid="mail-compose-attach"
            disabled={disabled}
            onClick={onAttach}
            title="Attach files"
          >
            Attach
          </button>
        )}
      </div>
      {editorMenu.render}
      <div
        ref={editorRef}
        className="flex-1 min-h-[240px] overflow-auto px-3 py-2 text-[13px] leading-6 outline-none bg-[var(--taomni-input-bg)] empty:before:content-['']"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-label="Message body"
        data-testid="mail-compose-editor"
        onInput={emitChange}
        onPaste={handlePaste}
      />
    </div>
  );
}

function ToolbarButton({
  label,
  testId,
  disabled,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="taomni-btn h-7 w-7 p-0 inline-flex items-center justify-center"
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MenuButton({
  label,
  testId,
  disabled,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="taomni-btn h-7 px-1.5 inline-flex items-center justify-center gap-0.5"
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      <ChevronDown className="w-3 h-3" />
    </button>
  );
}

function buildTableHtml(cols: number, rows: number): string {
  const cells = Array.from({ length: cols }, () => (
    '<td style="border: 1px solid #9ca3af; padding: 4px 8px;">&nbsp;</td>'
  )).join("");
  const body = Array.from({ length: rows }, () => `<tr>${cells}</tr>`).join("");
  return `<table style="border-collapse: collapse;"><tbody>${body}</tbody></table><p><br></p>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
