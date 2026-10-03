/**
 * macOS IME first-character fix.
 *
 * On macOS, IMEs such as Sogou and the system Pinyin input deliver committed text
 * through `input` (inputType="insertText") events, but mark every physical keydown
 * with `keyCode === 229` (the "input method is processing" sentinel), and these
 * events arrive in an inverted order: input → keydown → keyup.
 *
 * xterm.js (`Terminal._keyDown`) unconditionally sets an internal `_keyDownSeen`
 * flag on every keydown and clears it on keyup. Its `_inputEvent` then emits the
 * typed character only when `(!event.composed || !_keyDownSeen)`. While a modifier
 * (Shift/Meta) is held, its keydown leaves `_keyDownSeen === true`, so the first
 * committed character's (composed) `input` event is skipped — e.g. the first `@`
 * from Shift+2 never reaches the PTY, while the next character is fine. English /
 * non-IME input is unaffected because those keydowns are not keyCode 229.
 *
 * Fix: stop keyCode-229 keydowns from reaching xterm so the flag is never set by
 * IME-routed keys; the character still arrives via the `input` event and is emitted
 * normally. Ctrl/Cmd combinations are excluded so keyboard shortcuts keep working.
 * (Linux has a dedicated IME guard — see terminalImeGuard.ts — so this is macOS-only.)
 */
export function shouldSuppressMacImeKeydown(
  event: { key?: string; keyCode: number; ctrlKey?: boolean; metaKey?: boolean },
): boolean {
  if (event.keyCode !== 229) return false;
  // A lone Meta/Control pressed during an app/Space switch (the Cmd still held through
  // Cmd+Tab, Ctrl through a Space switch) also surfaces as keyCode 229 with its
  // modifier flag set, so the bare-key rule below would let it through. It must NOT
  // reach xterm: _keyDown sets _keyDownSeen, and that modifier's keyup is routed to
  // the window that took focus (lost) — so the flag sticks and the first committed
  // digit/symbol typed after returning is swallowed. A refocus reset can't help here:
  // the keydown arrives *after* focus is restored, re-setting the flag. A lone modifier
  // is never a shortcut's action key (that's the letter in Cmd+C / Ctrl+C), so the
  // combo's real key still reaches xterm and shortcuts keep working.
  if (event.key === "Meta" || event.key === "Control") return true;
  // Bare / Shift IME-routed input. Ctrl/Cmd *combos* (a letter with the modifier held)
  // pass through so shortcuts keep working.
  return !event.ctrlKey && !event.metaKey;
}

/**
 * Companion fix for refocus. When the user switches app/Space (Cmd+Tab, Ctrl+arrow,
 * trackpad swipe…), a modifier/arrow `keyup` can be delivered to the window that
 * took focus, leaving xterm's `_keyDownSeen` stuck `true`. On return, `_inputEvent`
 * then drops the first committed `insertText` character (digit/symbol) — letters are
 * unaffected because they arrive via IME composition, not `insertText`. The keydown
 * suppressor above can't help here (the stray key is a lost *keyup*, and may be a
 * non-229 key such as an arrow), so we clear the flag when the terminal regains
 * focus: at that moment no key is physically held, so resetting it is safe and
 * matches reality. Accesses xterm internals defensively (no-op if the field moves).
 */
export function clearStaleKeyDownSeen(term: { _core?: { _keyDownSeen?: boolean } }): void {
  const core = term._core;
  if (core && typeof core._keyDownSeen === "boolean") core._keyDownSeen = false;
}

/**
 * Window/visibility-level companion to {@link clearStaleKeyDownSeen}. The textarea
 * `focus` listener only fires when element focus actually changes (e.g. clicking
 * back into the terminal). But a plain app/Space switch (Cmd+Tab, Ctrl+arrow,
 * trackpad swipe…) keeps the terminal's textarea as `document.activeElement` the
 * whole time, so it never re-fires `focus` on return — and the textarea-focus reset
 * is missed, leaving `_keyDownSeen` stuck `true` (the stray gesture keyup was
 * delivered to the window that took focus). The window's `focus` and the document's
 * `visibilitychange` DO fire for those switches, so we clear the flag from there
 * too — but only when this terminal's textarea is still the active element, so a
 * refocus that lands on another pane/terminal doesn't reset an unrelated one.
 * Returns whether the flag was cleared.
 */
export function clearStaleKeyDownSeenIfActive(
  term: { textarea?: object | null; _core?: { _keyDownSeen?: boolean } },
  activeElement: unknown,
): boolean {
  if (!term.textarea || term.textarea !== activeElement) return false;
  clearStaleKeyDownSeen(term);
  return true;
}
