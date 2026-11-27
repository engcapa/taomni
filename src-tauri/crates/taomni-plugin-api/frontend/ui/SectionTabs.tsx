import type { ComponentProps, KeyboardEvent } from "react";

/** Move focus and activate through the same native button used by pointer input. */
export function SectionTabs({ children, ...props }: Omit<ComponentProps<"div">, "role" | "onKeyDown">) {
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const list = event.currentTarget;
    const focused = event.target;
    if (!(focused instanceof HTMLButtonElement) || focused.getAttribute("role") !== "tab"
      || focused.closest('[role="tablist"]') !== list) return;
    const vertical = list.getAttribute("aria-orientation") === "vertical";
    const next = vertical ? "ArrowDown" : "ArrowRight";
    const previous = vertical ? "ArrowUp" : "ArrowLeft";
    if (![next, previous, "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('button[role="tab"]:enabled'))
      .filter(tab => tab.closest('[role="tablist"]') === list && !tab.closest("[hidden], [inert]") && tab.getAttribute("aria-disabled") !== "true");
    const index = tabs.indexOf(focused);
    if (index < 0) return;
    let target: HTMLButtonElement;
    switch (event.key) {
      case "Home": target = tabs[0]; break;
      case "End": target = tabs[tabs.length - 1]; break;
      default: target = tabs[(index + (event.key === next ? 1 : -1) + tabs.length) % tabs.length];
    }
    event.preventDefault();
    event.stopPropagation();
    target.focus();
    if (target.getAttribute("aria-selected") !== "true") target.click();
  }
  return <div {...props} role="tablist" onKeyDown={navigate}>{children}</div>;
}

export function sectionTab(selected: boolean) {
  return { role: "tab", "aria-selected": selected, tabIndex: selected ? 0 : -1 } as const;
}
