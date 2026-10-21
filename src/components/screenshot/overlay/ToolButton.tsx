import type { ReactNode } from "react";

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
    <button
      type="button"
      data-testid={testid}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 ${active ? "" : "hover:bg-[var(--taomni-hover)]"
        }`}
      style={{
        background: active ? "var(--taomni-accent)" : undefined,
        color: active ? "#ffffff" : "var(--taomni-text)",
      }}
    >
      {children}
    </button>
  );
}
