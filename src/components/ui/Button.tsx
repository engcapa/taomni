import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";

type ButtonProps = ComponentProps<"button"> & {
  variant?: "default" | "primary" | "danger" | "ghost" | "link";
  busy?: boolean;
};

export function Button({ type = "button", variant = "default", busy = false, disabled,
  children, className = "", ...props }: ButtonProps) {
  return <button {...props} type={type} className={`taomni-btn ${className}`}
    data-primary={variant === "primary" || undefined} data-danger={variant === "danger" || undefined}
    data-variant={variant} disabled={disabled || busy} aria-busy={busy || undefined}>
    {busy && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />}
    {children}
  </button>;
}
