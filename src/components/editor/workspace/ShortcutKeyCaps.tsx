import { Fragment } from "react";
import type { Shortcut } from "./workspaceKeymapScheme";
import { detectKeymapPlatform, shortcutKeyCaps, type KeymapPlatform } from "./workspaceKeymapPlatform";

/**
 * IDEA-style split key caps (`Ctrl` `Shift` `N`) with faint inline `+`
 * separators, so text content and innerText read as the shared label, e.g.
 * `Ctrl+Shift+N` (ED-PARITY-013 DEC-013-02).
 */
export function ShortcutKeyCaps({
  shortcut,
  platform = detectKeymapPlatform(),
}: {
  shortcut: Shortcut;
  platform?: KeymapPlatform;
}) {
  const groups = shortcutKeyCaps(shortcut, platform);
  return (
    // Plain inline flow (no flex): flex items are blockified and would split
    // innerText into one line per key cap.
    <span className="inline whitespace-nowrap">
      {groups.map((caps, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 && " "}
          {caps.map((cap, capIndex) => (
            <Fragment key={`${groupIndex}-${capIndex}`}>
              {/* Inline (not visually hidden) so innerText stays `Ctrl+Shift+N`
                  on every WebView; sr-only's absolute box splits innerText lines. */}
              {capIndex > 0 && <span className="text-[9px] opacity-40">+</span>}
              <kbd className="mx-px inline rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 font-sans text-[10px] leading-4">
                {cap}
              </kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
