let guard: { allows: boolean; userMoved: boolean } | null = null;
export function shellTabActivationAllowed(): boolean { return !guard || guard.allows; }
/** Restore opens in the background; explicit user navigation keeps focus ownership. */
export function beginRestoreFocus() {
  const state = { allows: false, userMoved: false }; guard = state;
  const userAction = (event: Event) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-testid="tab-item"],[data-testid="shell-tab-card-open"],[data-testid="shell-rail-home"],[data-testid="shell-rail-settings"],[data-testid="shell-lane-select"]')) return;
    state.allows = true; state.userMoved = true;
    queueMicrotask(() => { state.allows = false; });
  };
  document.addEventListener("click", userAction, true); document.addEventListener("keydown", userAction, true); document.addEventListener("change", userAction, true);
  return () => {
    document.removeEventListener("click", userAction, true); document.removeEventListener("keydown", userAction, true); document.removeEventListener("change", userAction, true);
    if (guard === state) guard = null;
    return !state.userMoved;
  };
}
