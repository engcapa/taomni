import { Children, Fragment, cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";

function containsText(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => (
    typeof child === "string" || typeof child === "number"
    || (isValidElement<{ children?: ReactNode }>(child) && child.type !== "svg"
      && typeof child.type === "string" && containsText(child.props.children))
  ));
}

/** Present existing contextual controls as labelled rows, preserving handlers. */
export function TabActionMenuItems({ children }: { children: ReactNode }) {
  return <>{Children.map(children, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return child;
    if (child.type === Fragment) return <TabActionMenuItems>{child.props.children}</TabActionMenuItems>;
    if (child.type !== "button") return child;
    const button = child as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
    const label = button.props.title ?? button.props["aria-label"];
    return cloneElement(button, {
      role: button.props.role ?? "menuitem",
      className: `${button.props.className ?? ""} taomni-tab-action-menu-item`,
      style: { ...button.props.style, display: "flex", width: "100%", minHeight: 28, height: "auto",
        justifyContent: "flex-start", gap: 8, padding: "5px 10px", border: "none", borderRadius: 4,
        fontSize: "inherit", color: "inherit" },
      children: <>{button.props.children}{label && !containsText(button.props.children) && <span>{label}</span>}</>,
    });
  })}</>;
}
