import type { KeyboardEvent } from "react";

const CARD = '[data-testid="tab-overview-card"]';

export function focusOverviewCard(grid: HTMLElement | null, last = false): boolean {
  const cards = grid?.querySelectorAll<HTMLButtonElement>(CARD);
  const card = cards?.[last ? cards.length - 1 : 0];
  card?.focus();
  return Boolean(card);
}

export function moveOverviewFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  const { currentTarget: grid, key } = event;
  const target = event.target instanceof Element ? event.target.closest(CARD) : null;
  if (!target || !["Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return;
  const cards = Array.from(grid.querySelectorAll<HTMLButtonElement>(CARD));
  const index = cards.indexOf(target as HTMLButtonElement);
  if (index < 0) return;
  const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  const offset = key === "Tab" ? (event.shiftKey ? -1 : 1) : key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : key === "ArrowUp" ? -columns : columns;
  const next = index + offset;
  if (key === "Tab" && (next < 0 || next >= cards.length)) return;
  event.preventDefault();
  event.stopPropagation();
  cards[Math.max(0, Math.min(cards.length - 1, next))]?.focus();
}
