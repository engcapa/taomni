// Shared tab-action toolbar button styles.
//
// These buttons render in the ControlBar's tab-action slot (and the detached
// window's bar), so they blend into the app chrome rather than floating over
// dark session content: transparent background, theme text colour, subtle
// hover (see the `[data-tab-action] button:hover` rule in index.css).

import type { CSSProperties } from "react";

/** Labeled (icon + text) toolbar button. */
export const FT_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  height: 24,
  padding: "0 8px",
  background: "transparent",
  color: "var(--taomni-text)",
  border: "1px solid transparent",
  borderRadius: 4,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// Square icon-only button. Slightly larger hit area + centered glyph so the
// distinct lucide icons (reconnect / detach / maximize…) are easy to tell
// apart at a glance.
export const FT_ICON_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 24,
  padding: 0,
  background: "transparent",
  color: "var(--taomni-text)",
  border: "1px solid transparent",
  borderRadius: 4,
  cursor: "pointer",
};

// Thin vertical rule that visually groups related toolbar buttons.
export const FT_SEPARATOR_STYLE: CSSProperties = {
  width: 1,
  height: 16,
  alignSelf: "center",
  margin: "0 3px",
  background: "var(--taomni-divider)",
};

/** Accent override merged onto FT_BUTTON_STYLE for active toggle buttons
 *  (e.g. terminal SFTP / chat toggles when open). */
export const FT_BUTTON_ACTIVE_OVERRIDE: CSSProperties = {
  background: "var(--taomni-selected)",
  color: "var(--taomni-text)",
  borderColor: "var(--taomni-accent)",
};
