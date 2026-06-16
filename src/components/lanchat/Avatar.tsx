import type { CSSProperties } from "react";

import type { LanPresence } from "../../types";
import { avatarGradient, avatarInitial, presenceColor } from "./util";

interface AvatarProps {
  name: string;
  /** Stable key for the gradient (defaults to name). */
  colorKey?: string;
  /** base64 image (raw or data-URL); falls back to a gradient + initial. */
  avatarBase64?: string | null;
  size?: number;
  radius?: number;
  status?: LanPresence | null;
  /** Override for `#` group avatars etc. */
  label?: string;
  /** Border color for the presence ring (matches the surrounding surface). */
  ringColor?: string;
}

/** Avatar with optional presence dot, matching the prototype look. */
export function Avatar({
  name,
  colorKey,
  avatarBase64,
  size = 32,
  radius = 9,
  status,
  label,
  ringColor = "var(--taomni-panel-bg)",
}: AvatarProps) {
  const src = avatarBase64
    ? avatarBase64.startsWith("data:")
      ? avatarBase64
      : `data:image/png;base64,${avatarBase64}`
    : null;
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: radius,
    flex: `0 0 ${size}px`,
    display: "grid",
    placeItems: "center",
    color: "#fff",
    fontWeight: 600,
    position: "relative",
    background: src ? undefined : avatarGradient(colorKey ?? name),
    fontSize: Math.round(size * 0.42),
    overflow: "hidden",
  };
  return (
    <div style={style}>
      {src ? (
        <img src={src} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        (label ?? avatarInitial(name))
      )}
      {status ? (
        <span
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: Math.max(9, Math.round(size * 0.3)),
            height: Math.max(9, Math.round(size * 0.3)),
            borderRadius: "50%",
            border: `2px solid ${ringColor}`,
            background: presenceColor(status),
          }}
        />
      ) : null}
    </div>
  );
}
