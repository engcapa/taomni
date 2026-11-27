import type { ReactNode } from "react";
import { IconButton } from "../../ui/IconButton";

export function ToolButton({
  testid,
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  testid: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <IconButton
      type="button"
      data-testid={testid}
      label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 ${active ? "" : "hover:bg-[var(--taomni-hover)]"
        }`}
      style={{
        background: active ? "var(--taomni-primary-bg)" : undefined,
        color: active ? "var(--taomni-primary-text)" : "var(--taomni-text)",
      }}
    >
      {children}
    </IconButton>
  );
}
