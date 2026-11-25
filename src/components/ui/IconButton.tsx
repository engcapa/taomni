import type { ComponentProps } from "react";
import { useT } from "../../lib/i18n";
import type { en } from "../../lib/i18n/locales/en";

type ActionKey = keyof typeof en.iconActions;
type Label = { label: string; labelKey?: never } | { labelKey: ActionKey; label?: never };
type IconButtonProps = Omit<ComponentProps<"button">, "title" | "aria-label"> & Label & {
  hint?: string;
  hintKey?: ActionKey;
};

/** Keep an icon action's name available to assistive technology and pointer users. */
export function IconButton({ label, labelKey, hint, hintKey, type = "button", ...button }: IconButtonProps) {
  const t = useT();
  const name = labelKey === undefined ? label : t(`iconActions.${labelKey}`);
  const description = hintKey ? t(`iconActions.${hintKey}`) : hint;
  return <button {...button} type={type} aria-label={name} aria-description={description}
    data-taomni-tooltip={description ?? name} />;
}
