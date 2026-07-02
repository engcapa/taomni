import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Eraser,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Smile,
  Underline,
} from "lucide-react";
import { mailHtmlToPlainText, sanitizeMailComposeHtml } from "../../lib/mailHtml";

interface RichMailEditorProps {
  html: string;
  disabled?: boolean;
  onChange: (html: string, text: string) => void;
  onRichFormatUsed?: () => void;
  onAttach?: () => void;
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

export function RichMailEditor({
  html,
  disabled = false,
  onChange,
  onRichFormatUsed,
  onAttach,
}: RichMailEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [color, setColor] = useState("#1f2937");

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
        <ToolbarButton label="Insert smile" testId="mail-compose-emoji" disabled={disabled} onClick={() => insertHtml("🙂", false)}><Smile className="w-3.5 h-3.5" /></ToolbarButton>
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
