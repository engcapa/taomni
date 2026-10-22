import { resolveTerminalTheme, type TerminalCursorStyle } from "../../../lib/terminalProfile";

export function TerminalPreview({
  background,
  foreground,
  fontFamily,
  fontSize,
  cursorStyle,
  cursorBlink,
  theme,
}: {
  background: string;
  foreground: string;
  fontFamily: string;
  fontSize: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  theme: ReturnType<typeof resolveTerminalTheme>;
}) {
  const cursorColor = theme.cursor ?? foreground;

  return (
    <div
      data-testid="terminal-preview"
      className="rounded-md p-3 taomni-mono leading-relaxed border border-black/10"
      style={{ background, color: foreground, fontFamily, fontSize }}
    >
      <span style={{ color: theme.green ?? "#62d36f" }}>user@host</span>
      <span style={{ color: "#bbbbbb" }}>:</span>
      <span style={{ color: theme.blue ?? "#83a7d8" }}>~/srv</span>
      {"$ tail -f /var/log/nginx/error.log"}
      <br />
      <span style={{ color: theme.yellow ?? "#e3a85e" }}>warning</span>
      {": 2 worker connections are not enough"}
      <br />
      <span style={{ color: theme.red ?? "#ff6b6b" }}>error</span>
      {": connect() failed (111: Connection refused)"}
      <br />
      <TerminalPreviewCursor
        color={cursorColor}
        foreground={foreground}
        styleName={cursorStyle}
        blink={cursorBlink}
      />
    </div>
  );
}

export function TerminalPreviewCursor({
  color,
  foreground,
  styleName,
  blink,
}: {
  color: string;
  foreground: string;
  styleName: TerminalCursorStyle;
  blink: boolean;
}) {
  const className = blink ? "taomni-blink" : "";

  if (styleName === "underline") {
    return (
      <span
        data-testid="terminal-preview-cursor"
        className={`inline-block w-[0.65em] h-[1em] align-[-0.1em] ${className}`}
        style={{ borderBottom: `2px solid ${color}` }}
      />
    );
  }

  if (styleName === "bar") {
    return (
      <span
        data-testid="terminal-preview-cursor"
        className={`inline-block w-[0.4em] h-[1em] align-[-0.1em] ${className}`}
        style={{ borderLeft: `2px solid ${color}` }}
      />
    );
  }

  return (
    <span
      data-testid="terminal-preview-cursor"
      className={`inline-block w-[0.65em] h-[1em] align-[-0.1em] ${className}`}
      style={{ background: color, color: foreground }}
    />
  );
}

export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function themeColor(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
