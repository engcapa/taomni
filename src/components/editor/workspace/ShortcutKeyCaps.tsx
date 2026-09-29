import { Fragment } from "react";
import type { Shortcut } from "./workspaceKeymapScheme";
import { detectKeymapPlatform, shortcutKeyCaps, type KeymapPlatform } from "./workspaceKeymapPlatform";

/**
 * IDEA-style split key caps (`Ctrl` `Shift` `N`). The `+` separators stay in
 * the DOM (visually hidden) so the text content and accessible name read as
 * the shared label, e.g. `Ctrl+Shift+N` (ED-PARITY-013 DEC-013-02).
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
    <span className="inline-flex items-center gap-1">
      {groups.map((caps, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 && <span className="px-0.5 opacity-60"> </span>}
          {caps.map((cap, capIndex) => (
            <Fragment key={`${groupIndex}-${capIndex}`}>
              {capIndex > 0 && <span className="sr-only">+</span>}
              <kbd className="rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 font-sans text-[10px] leading-4">
                {cap}
              </kbd>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
