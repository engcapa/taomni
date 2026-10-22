import { Terminal } from "@xterm/xterm";
import { clearStaleKeyDownSeen, clearStaleKeyDownSeenIfActive, shouldSuppressMacImeKeydown } from "../../../lib/terminal/macImeKeydown";
import type { TerminalSessionLifetime } from "./sessionContracts";
import { type TerminalSessionLifecycleContext } from "./sessionContracts";


export interface InstallTerminalCompositionContext {
  term: Terminal;
  controllerContext: TerminalSessionLifecycleContext;
  el: HTMLDivElement;
  lifetime: TerminalSessionLifetime;
}

export function installTerminalComposition(context: InstallTerminalCompositionContext) {
  const { term, controllerContext, el, lifetime } = context;

  // Lock helper-textarea position during CJK IME composition to prevent candidate box jumping
  // when background text animations (e.g. Claude Code spinners) trigger cursor repositioning.
  const textarea = term.textarea;
  if (textarea) {
    let isComposing = false;
    let lockedLeft = "";
    let lockedTop = "";

    const onCompositionStart = () => {
      controllerContext.isComposingRef.current = true;
      isComposing = true;
      lockedLeft = textarea.style.left;
      lockedTop = textarea.style.top;
    };

    const onCompositionEnd = () => {
      controllerContext.isComposingRef.current = false;
      isComposing = false;
      // Flush any PTY output buffered during composition
      if (controllerContext.compositionBufferRef.current.length > 0) {
        for (const chunk of controllerContext.compositionBufferRef.current) {
          term.write(chunk);
        }
        controllerContext.compositionBufferRef.current = [];
      }
    };

    textarea.addEventListener("compositionstart", onCompositionStart);
    textarea.addEventListener("compositionend", onCompositionEnd);

    // macOS IME first-character fix. macOS IMEs (Sogou/Pinyin…) deliver committed text
    // via `input` (insertText) events but mark every keydown with keyCode 229, arriving
    // input → keydown → keyup. xterm's _keyDown sets `_keyDownSeen` for those, and its
    // _inputEvent then skips a composed character while the flag is set — so the first
    // char typed with a modifier held (e.g. the `@` from Shift+2) is dropped before it
    // reaches the PTY. Swallow keyCode-229 keydowns (capture phase, on the container so
    // it runs before xterm's textarea handler) so the flag is never set; the character
    // still arrives via `input`. Ctrl/Cmd combos pass through so shortcuts keep working.
    // (Linux uses its own guard above; see shouldSuppressMacImeKeydown for details.)
    const onMacImeKeydownCapture = (e: KeyboardEvent) => {
      if (controllerContext.isMac && shouldSuppressMacImeKeydown(e)) e.stopImmediatePropagation();
    };
    el.addEventListener("keydown", onMacImeKeydownCapture, true);

    // Refocus companion (see clearStaleKeyDownSeen): switching app/Space can drop a
    // modifier/arrow keyup on the other window, leaving xterm's `_keyDownSeen` stuck
    // true so the first digit/symbol typed on return is swallowed (letters, which go
    // through IME composition, are unaffected). Clear it whenever the terminal regains
    // focus — no key is actually held at that point.
    const onMacImeFocus = () => {
      if (controllerContext.isMac) clearStaleKeyDownSeen(term as unknown as { _core?: { _keyDownSeen?: boolean; }; });
    };
    textarea.addEventListener("focus", onMacImeFocus);

    // The textarea-focus reset above only fires when element focus actually
    // changes. A plain app/Space switch (Cmd+Tab, Ctrl+arrow) keeps the textarea
    // as document.activeElement, so it never re-fires `focus` on return and the
    // first digit/symbol is still swallowed (the stray gesture keyup was lost to
    // the window that took focus). The window's `focus` and the document's
    // `visibilitychange` DO fire for those switches — clear the stale flag from
    // there too, guarded to this terminal's textarea so other panes are untouched.
    const onMacImeWindowRefocus = () => {
      if (!controllerContext.isMac || document.visibilityState === "hidden") return;
      clearStaleKeyDownSeenIfActive(
        term as unknown as { textarea?: object | null; _core?: { _keyDownSeen?: boolean; }; },
        document.activeElement,
      );
    };
    window.addEventListener("focus", onMacImeWindowRefocus);
    document.addEventListener("visibilitychange", onMacImeWindowRefocus);

    const observer = new MutationObserver(() => {
      if (isComposing) {
        observer.disconnect();
        if (textarea.style.left !== lockedLeft) {
          textarea.style.left = lockedLeft;
        }
        if (textarea.style.top !== lockedTop) {
          textarea.style.top = lockedTop;
        }
        observer.observe(textarea, { attributes: true, attributeFilter: ["style"] });
      }
    });

    observer.observe(textarea, { attributes: true, attributeFilter: ["style"] });

    lifetime.cleanupImePositionLock = () => {
      textarea.removeEventListener("compositionstart", onCompositionStart);
      textarea.removeEventListener("compositionend", onCompositionEnd);
      el.removeEventListener("keydown", onMacImeKeydownCapture, true);
      textarea.removeEventListener("focus", onMacImeFocus);
      window.removeEventListener("focus", onMacImeWindowRefocus);
      document.removeEventListener("visibilitychange", onMacImeWindowRefocus);
      observer.disconnect();
      controllerContext.compositionBufferRef.current = [];
    };
  }

}
