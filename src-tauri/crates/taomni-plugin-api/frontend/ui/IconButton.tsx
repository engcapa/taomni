import type { ComponentProps } from "react";

export type IconButtonProps = Omit<ComponentProps<"button">, "title" | "aria-label"> & {
  label: string;
  hint?: string;
};

export function IconButton({ label, hint, type = "button", ...button }: IconButtonProps) {
  return <button {...button} type={type} aria-label={label} aria-description={hint}
    data-taomni-tooltip={hint ?? label} />;
}
