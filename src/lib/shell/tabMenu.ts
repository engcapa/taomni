import type { MouseEvent } from "react";
let handler: ((event: MouseEvent, tabId: string) => void) | undefined;
export function installShellTabMenu(value: NonNullable<typeof handler>) { handler = value; return () => { if (handler === value) handler = undefined; }; }
export function showShellTabMenu(event: MouseEvent, tabId: string) { handler?.(event, tabId); }
