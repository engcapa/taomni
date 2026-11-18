export type ContentZoomAction = "in" | "out" | "reset";

export function contentZoomShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "key">): ContentZoomAction | undefined {
  if (!event.ctrlKey) return;
  if (event.key === "+" || event.key === "=") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "0") return "reset";
}
