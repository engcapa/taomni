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
  event: Pick<KeyboardEvent, "keyCode" | "ctrlKey" | "metaKey">,
): boolean {
  return event.keyCode === 229 && !event.ctrlKey && !event.metaKey;
}
