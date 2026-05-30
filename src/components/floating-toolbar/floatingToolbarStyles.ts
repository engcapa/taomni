// Shared floating-toolbar button styles.
//
// Extracted from RdpPanel so every tab-overlay toolbar (RDP / terminal /
// VNC) renders visually identical chrome: same icon-box size, background
// opacity, border, and text colour. RdpPanel is the visual reference —
// these values are its originals, kept verbatim.

import type { CSSProperties } from "react";

/** Labeled (icon + text) toolbar button. */
export const FT_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  padding: "3px 8px",
  background: "rgba(0,0,0,0.45)",
  color: "#ddd",
  border: "1px solid rgba(255,255,255,0.18)",
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
  width: 26,
  height: 24,
  padding: 0,
  background: "rgba(0,0,0,0.45)",
  color: "#ddd",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 4,
  cursor: "pointer",
};

// Thin vertical rule that visually groups related toolbar buttons.
export const FT_SEPARATOR_STYLE: CSSProperties = {
  width: 1,
  alignSelf: "stretch",
  margin: "2px 2px",
  background: "rgba(255,255,255,0.18)",
};

/** Accent override merged onto FT_BUTTON_STYLE for active toggle buttons
 *  (e.g. terminal SFTP / chat toggles when open). */
export const FT_BUTTON_ACTIVE_OVERRIDE: CSSProperties = {
  background: "var(--moba-accent)",
  color: "#fff",
};
